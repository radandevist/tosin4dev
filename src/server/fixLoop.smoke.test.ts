import { ObjectId } from "mongodb";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_FIX_ATTEMPTS, fixSignature } from "../domain/fix-loop";

const TEST_DB = `tosin4dev-test-fix-loop-${process.pid}-${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;

const { db, closeDb } = await import("./db");
const { deliverFixFeedback } = await import("./supervisor.server");

const FAILING = [{ key: "lint", exitCode: 1, output: "error: unused var" }];

async function seedRun(over: Record<string, unknown>): Promise<string> {
  const database = await db();
  await database.collection("runs").deleteMany({});
  const id = new ObjectId();
  await database.collection("runs").insertOne({
    _id: id,
    ticketId: new ObjectId().toString(),
    boardId: new ObjectId().toString(),
    runner: "claude",
    phase: "execute",
    status: "verifying",
    workDir: "/tmp/wd",
    promptFile: "/tmp/p",
    logFile: "/tmp/l",
    stderrFile: null,
    exitCode: 0,
    summary: null,
    branch: "tosin4dev/run/x",
    baseSha: "a".repeat(40),
    verdict: null,
    failureKind: null,
    executionSessionId: "sess-1",
    executionLeaseId: null,
    executionLeaseExpiresAt: null,
    parkedBy: "question",
    awaitingQuestion: null,
    exchanges: [],
    turns: [],
    fixAttempts: 0,
    lastFixSignature: null,
    queuedAt: "2026-08-07T00:00:00.000Z",
    startedAt: "2026-08-07T00:00:00.000Z",
    ...over,
  });
  return id.toString();
}

describe("deliverFixFeedback", () => {
  beforeEach(async () => {
    const database = await db();
    await database.collection("runs").deleteMany({});
  });

  afterAll(async () => {
    await (await db()).dropDatabase();
    await closeDb();
  });

  it("stops when the attempt budget is exhausted", async () => {
    const runId = await seedRun({ fixAttempts: MAX_FIX_ATTEMPTS });
    const decision = await deliverFixFeedback(runId, FAILING, "2026-08-07T01:00:00.000Z");
    expect(decision).toEqual({ retry: false, reason: "budget_exhausted" });
  });

  it("stops on a repeated signature before spending the remaining budget", async () => {
    const runId = await seedRun({
      fixAttempts: 1,
      lastFixSignature: fixSignature(FAILING),
    });
    const decision = await deliverFixFeedback(runId, FAILING, "2026-08-07T01:00:00.000Z");
    expect(decision).toEqual({ retry: false, reason: "repeated_failure" });
    const database = await db();
    const run = await database.collection("runs").findOne({ _id: new ObjectId(runId) });
    // Budget was NOT consumed by a decision that never delivered anything.
    expect(run?.fixAttempts).toBe(1);
  });

  it("does not mark feedback delivered when the run is parked awaiting input", async () => {
    const runId = await seedRun({ status: "awaiting_input" });
    const decision = await deliverFixFeedback(runId, FAILING, "2026-08-07T01:00:00.000Z");
    expect(decision).toEqual({ retry: false, reason: "suppressed" });
    const database = await db();
    const run = await database.collection("runs").findOne({ _id: new ObjectId(runId) });
    expect(run?.lastFixSignature).toBeNull();
    expect(run?.fixAttempts).toBe(0);
  });

  it("records the signature and increments the budget on a real delivery", async () => {
    const runId = await seedRun({});
    const decision = await deliverFixFeedback(runId, FAILING, "2026-08-07T01:00:00.000Z");
    expect(decision).toEqual({ retry: true });
    const database = await db();
    const run = await database.collection("runs").findOne({ _id: new ObjectId(runId) });
    expect(run?.fixAttempts).toBe(1);
    expect(run?.lastFixSignature).toBe(fixSignature(FAILING));
  });
});
