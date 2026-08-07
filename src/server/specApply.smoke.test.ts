import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectId } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_DB = `tosin4dev-test-spec-apply-${process.pid}-${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;

const { db } = await import("./db");
const { applyDraftedSpec } = await import("./supervisor.server");

let runDir: string;
let ticketId: string;

async function seedTicket(status: string): Promise<string> {
  const database = await db();
  await database.collection("tickets").deleteMany({});
  const id = new ObjectId();
  await database.collection("tickets").insertOne({
    _id: id,
    boardId: new ObjectId().toString(),
    seq: 1,
    title: "confetti",
    status,
    runner: "claude",
    activeRunId: null,
    dependsOn: [],
    activity: [],
    spec: {
      intent: "confetti on landing",
      scope: "",
      nonGoals: "",
      acceptance: [],
      links: [],
      risk: "low",
      approvedAt: null,
      approvedBy: null,
    },
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  });
  return id.toString();
}

describe("applyDraftedSpec", () => {
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "t4d-sa-"));
    ticketId = await seedTicket("inbox");
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("writes the draft and moves the ticket to spec_review", async () => {
    await writeFile(
      join(runDir, "spec.json"),
      JSON.stringify({
        intent: "confetti on first visit",
        scope: "apps/front",
        acceptance: ["fires once per browser"],
        risk: "medium",
      }),
    );
    await applyDraftedSpec(ticketId, runDir, "2026-08-07T01:00:00.000Z");
    const database = await db();
    const t = await database
      .collection("tickets")
      .findOne({ _id: new ObjectId(ticketId) });
    expect(t?.status).toBe("spec_review");
    expect(t?.spec.intent).toBe("confetti on first visit");
    expect(t?.spec.acceptance).toEqual(["fires once per browser"]);
    expect(t?.spec.risk).toBe("medium");
    // The runner may not approve its own draft.
    expect(t?.spec.approvedAt).toBeNull();
    expect(t?.spec.approvedBy).toBeNull();
  });

  it("leaves the ticket in inbox when the draft is invalid", async () => {
    await writeFile(join(runDir, "spec.json"), JSON.stringify({ scope: "x" }));
    await applyDraftedSpec(ticketId, runDir, "2026-08-07T01:00:00.000Z");
    const database = await db();
    const t = await database
      .collection("tickets")
      .findOne({ _id: new ObjectId(ticketId) });
    expect(t?.status).toBe("inbox");
    expect(t?.spec.intent).toBe("confetti on landing");
    // A failed draft must be visible, not a silent no-op: record activity
    // naming the failure while leaving status and spec untouched.
    expect(t?.spec).toEqual(
      expect.objectContaining({ intent: "confetti on landing" }),
    );
    expect(t?.activity).toContainEqual(
      expect.objectContaining({
        kind: "spec",
        message: "spec draft produced no usable spec.json",
      }),
    );
  });

  it("refuses to clobber a ticket that has left inbox", async () => {
    const moved = await seedTicket("spec_review");
    await writeFile(
      join(runDir, "spec.json"),
      JSON.stringify({ intent: "late draft" }),
    );
    await applyDraftedSpec(moved, runDir, "2026-08-07T01:00:00.000Z");
    const database = await db();
    const t = await database
      .collection("tickets")
      .findOne({ _id: new ObjectId(moved) });
    expect(t?.spec.intent).toBe("confetti on landing");
    // The refusal must be a total no-op: no activity, no timestamp bump.
    expect(t?.updatedAt).toBe("2026-08-07T00:00:00.000Z");
    expect(t?.activity).toEqual([]);
  });
});
