import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Point the lazy db() singleton at a throwaway database *before* the first
// connection. Unique per run so parallel suites never collide.
const TEST_DB = `tosin4dev-test-tickets-${process.pid}-${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;

const { db, closeDb, ObjectId } = await import("./db");
const {
  createTicketCore,
  getTicketCore,
  listTicketsCore,
  transitionTicketCore,
  updateSpecCore,
  TransitionInputSchema,
} = await import("./tickets");
const { CreateTicketInputSchema, UpdateSpecInputSchema } = await import(
  "../domain/schemas"
);

const BOARD_ID = "0123456789abcdef01234567";

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    boardId: BOARD_ID,
    title: "Fix invitation docs",
    type: "implement" as const,
    runner: "claude" as const,
    spec: {
      intent: "Remove the expiry background job from docs",
      scope: "docs only",
      nonGoals: "",
      acceptance: ["docs updated"],
      links: [],
      risk: "low" as const,
    },
    ...overrides,
  };
}

async function tickets() {
  return (await db()).collection("tickets");
}

describe("tickets server functions", () => {
  beforeAll(async () => {
    await (await tickets()).deleteMany({});
  });

  afterAll(async () => {
    await (await db()).dropDatabase();
    await closeDb();
  });

  it("creates a ticket, initialising all server-owned fields, and returns string ids", async () => {
    const { id, seq } = await createTicketCore(makeInput());
    expect(id).toMatch(/^[0-9a-fA-F]{24}$/);
    expect(seq).toBe(1);

    const dto = await getTicketCore(BOARD_ID, seq);
    expect(typeof dto._id).toBe("string");
    expect(dto.boardId).toBe(BOARD_ID);
    expect(dto.status).toBe("inbox");
    expect(dto.activeRunId).toBeNull();
    expect(dto.prUrl).toBeNull();
    expect(dto.spec.approvedAt).toBeNull();
    expect(typeof dto.createdAt).toBe("string");
    expect(typeof dto.updatedAt).toBe("string");
  });

  it("assigns sequential per-board seq numbers", async () => {
    await (await tickets()).deleteMany({});
    const a = await createTicketCore(makeInput({ title: "A" }));
    const b = await createTicketCore(makeInput({ title: "B" }));
    const c = await createTicketCore(makeInput({ title: "C" }));
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
  });

  it("rejects create input carrying server-owned fields", () => {
    const bad = CreateTicketInputSchema.safeParse({
      ...makeInput(),
      seq: 5,
      status: "approved",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an update spec that carries approvedAt", () => {
    const bad = UpdateSpecInputSchema.safeParse({
      ticketId: BOARD_ID,
      spec: { ...makeInput().spec, approvedAt: new Date().toISOString() },
    });
    expect(bad.success).toBe(false);
  });

  it("lists tickets newest-seq first", async () => {
    await (await tickets()).deleteMany({});
    await createTicketCore(makeInput({ title: "first" }));
    await createTicketCore(makeInput({ title: "second" }));
    const seqs = (await listTicketsCore(BOARD_ID)).map((t) => t.seq);
    expect(seqs).toEqual([2, 1]);
  });

  it("throws a useful not-found error for a missing ticket", async () => {
    await expect(getTicketCore(BOARD_ID, 9999)).rejects.toThrow(/not found/i);
  });

  describe("transitions (human events only)", () => {
    it("accepts only human UI events, never machine/supervisor events", () => {
      for (const ok of [
        "submit_spec",
        "approve_spec",
        "request_spec_changes",
        "resume",
        "approve_final",
        "request_changes",
        "archive",
      ]) {
        expect(TransitionInputSchema.safeParse({ ticketId: BOARD_ID, event: ok }).success).toBe(true);
      }
      for (const bad of ["dispatch", "run_succeeded", "run_failed"]) {
        expect(TransitionInputSchema.safeParse({ ticketId: BOARD_ID, event: bad }).success).toBe(false);
      }
    });

    it("rejects a server-owned prUrl on the public input", () => {
      const bad = TransitionInputSchema.safeParse({
        ticketId: BOARD_ID,
        event: "approve_final",
        prUrl: "https://github.com/x/y/pull/1",
      });
      expect(bad.success).toBe(false);
    });

    it("stamps spec.approvedAt server-side on approve_spec", async () => {
      await (await tickets()).deleteMany({});
      const { id } = await createTicketCore(makeInput());
      await transitionTicketCore({ ticketId: id, event: "submit_spec" });
      const { status } = await transitionTicketCore({
        ticketId: id,
        event: "approve_spec",
      });
      expect(status).toBe("approved");
      const dto = await getTicketCore(BOARD_ID, 1);
      expect(typeof dto.spec.approvedAt).toBe("string");
    });

    it("rejects a stale transition atomically (only one concurrent winner)", async () => {
      await (await tickets()).deleteMany({});
      const { id } = await createTicketCore(makeInput());
      // Drive to review_ready directly so both racers share the same `from`.
      await (await tickets()).updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "review_ready" } },
      );
      const results = await Promise.allSettled([
        transitionTicketCore({ ticketId: id, event: "approve_final" }),
        transitionTicketCore({ ticketId: id, event: "approve_final" }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const dto = await getTicketCore(BOARD_ID, 1);
      expect(dto.status).toBe("done");
      // Exactly one transition was applied — no double-write.
      const applied = dto.activity.filter(
        (a) => a.message === "review_ready --approve_final--> done",
      );
      expect(applied).toHaveLength(1);
    });

    it("clears prior approval metadata when the spec is updated", async () => {
      await (await tickets()).deleteMany({});
      const { id } = await createTicketCore(makeInput());
      await transitionTicketCore({ ticketId: id, event: "submit_spec" });
      await transitionTicketCore({ ticketId: id, event: "approve_spec" });
      await updateSpecCore({
        ticketId: id,
        spec: { ...makeInput().spec, intent: "revised intent" },
      });
      const dto = await getTicketCore(BOARD_ID, 1);
      expect(dto.spec.intent).toBe("revised intent");
      expect(dto.spec.approvedAt).toBeNull();
    });

    it("rejects updateSpec for a missing ticket", async () => {
      await expect(
        updateSpecCore({
          ticketId: "ffffffffffffffffffffffff",
          spec: makeInput().spec,
        }),
      ).rejects.toThrow(/not found/i);
    });

    it("caps activity at the last 50 entries", async () => {
      await (await tickets()).deleteMany({});
      const { id } = await createTicketCore(makeInput());
      for (let i = 0; i < 55; i++) {
        await updateSpecCore({
          ticketId: id,
          spec: { ...makeInput().spec, intent: `intent ${i}` },
        });
      }
      const dto = await getTicketCore(BOARD_ID, 1);
      expect(dto.activity.length).toBe(50);
    });
  });

  it("enforces unique boardId+seq via the index", async () => {
    await (await tickets()).deleteMany({});
    const c = await tickets();
    await c.insertOne({ boardId: BOARD_ID, seq: 1, title: "x" });
    await expect(
      c.insertOne({ boardId: BOARD_ID, seq: 1, title: "y" }),
    ).rejects.toThrow();
  });
});
