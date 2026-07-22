import type { Db } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DB = `tosin4dev-test-bundle-lock-${process.pid}-${Date.now()}`;
const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;

const createControl = vi.hoisted(() => ({ calls: 0, failOnSecond: false }));

vi.mock("./tickets.server", async () => {
  const actual = await vi.importActual<typeof import("./tickets.server")>(
    "./tickets.server",
  );
  return {
    ...actual,
    createTicketCore: async (
      input: Parameters<typeof actual.createTicketCore>[0],
    ): ReturnType<typeof actual.createTicketCore> => {
      createControl.calls += 1;
      if (createControl.failOnSecond && createControl.calls === 2) {
        throw new Error("injected second-ticket create failure");
      }
      return actual.createTicketCore(input);
    },
  };
});

const { db, closeDb, ObjectId } = await import("./db");
const { lockBundleCore } = await import("./specBundles.server");

let database: Db;

const spec = (intent: string) => ({
  intent,
  scope: "",
  nonGoals: "",
  acceptance: [],
  links: [],
  risk: "low" as const,
});

async function insertFixture(status: "drafting" | "locked" = "drafting") {
  const at = new Date().toISOString();
  const board = await database.collection("boards").insertOne({
    slug: `bundle-lock-${new ObjectId().toString()}`,
    name: "Bundle lock",
    repoPath: "/tmp/tosin4dev-bundle-lock",
    defaultBaseBranch: "main",
    checks: [],
    createdAt: at,
    updatedAt: at,
  });
  const boardId = board.insertedId.toString();
  const session = await database.collection("chatSessions").insertOne({
    boardId,
    status: "active",
    createdAt: at,
    updatedAt: at,
  });
  const sessionId = session.insertedId.toString();
  const bundle = await database.collection("specBundles").insertOne({
    sessionId,
    boardId,
    status,
    rationale: "Split the work",
    members: [
      {
        localKey: "t1",
        title: "First ticket",
        type: "implement",
        runner: "claude",
        spec: spec("Implement the first ticket"),
        dependsOn: [],
      },
      {
        localKey: "t2",
        title: "Second ticket",
        type: "review",
        runner: "codex",
        spec: spec("Review the first ticket"),
        dependsOn: ["t1"],
      },
      {
        localKey: "t3",
        title: "Third ticket",
        type: "bugfix",
        runner: "claude",
        spec: spec("Fix the third ticket"),
        dependsOn: [],
      },
    ],
    lockedTicketIds: status === "locked" ? [] : null,
    createdAt: at,
    updatedAt: at,
    lockedAt: status === "locked" ? at : null,
  });
  return { boardId, sessionId, bundleId: bundle.insertedId.toString() };
}

beforeAll(async () => {
  database = await db();
});

beforeEach(async () => {
  createControl.calls = 0;
  createControl.failOnSecond = false;
  await Promise.all([
    database.collection("boards").deleteMany({}),
    database.collection("chatSessions").deleteMany({}),
    database.collection("specBundles").deleteMany({}),
    database.collection("tickets").deleteMany({}),
  ]);
});

afterAll(async () => {
  await database?.dropDatabase();
  await closeDb();
  process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;
});

describe("lockBundleCore", () => {
  it("creates inbox tickets in member order, resolves dependencies, and locks the session", async () => {
    const { boardId, sessionId, bundleId } = await insertFixture();

    const result = await lockBundleCore({ bundleId });
    const tickets = await database
      .collection("tickets")
      .find({ boardId })
      .sort({ seq: 1 })
      .toArray();

    expect(tickets).toHaveLength(3);
    expect(tickets.map((ticket) => ticket.title)).toEqual([
      "First ticket",
      "Second ticket",
      "Third ticket",
    ]);
    expect(tickets.map((ticket) => ticket.status)).toEqual([
      "inbox",
      "inbox",
      "inbox",
    ]);
    expect(tickets.map((ticket) => ticket.seq)).toEqual([1, 2, 3]);
    expect(result.tickets).toEqual(
      tickets.map((ticket) => ({ ticketId: ticket._id.toString(), seq: ticket.seq })),
    );
    expect(tickets[1].dependsOn).toEqual([tickets[0]._id.toString()]);

    const bundle = await database
      .collection("specBundles")
      .findOne({ _id: new ObjectId(bundleId) });
    expect(bundle).toMatchObject({
      status: "locked",
      lockedTicketIds: tickets.map((ticket) => ticket._id.toString()),
    });
    expect(bundle?.lockedAt).toEqual(expect.any(String));

    const session = await database
      .collection("chatSessions")
      .findOne({ _id: new ObjectId(sessionId) });
    expect(session?.status).toBe("bundle_locked");
  });

  it("deletes created tickets and restores drafting when the second create fails", async () => {
    const { boardId, bundleId } = await insertFixture();
    createControl.failOnSecond = true;

    await expect(lockBundleCore({ bundleId })).rejects.toMatchObject({
      code: "spawn_failed",
    });

    expect(createControl.calls).toBe(2);
    expect(await database.collection("tickets").countDocuments({ boardId })).toBe(0);
    const bundle = await database
      .collection("specBundles")
      .findOne({ _id: new ObjectId(bundleId) });
    expect(bundle).toMatchObject({
      status: "drafting",
      lockedAt: null,
      lockedTicketIds: null,
    });
  });

  it("rejects an already locked bundle as a conflict", async () => {
    const { bundleId } = await insertFixture("locked");

    await expect(lockBundleCore({ bundleId })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(createControl.calls).toBe(0);
  });
});
