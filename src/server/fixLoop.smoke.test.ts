import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_FIX_ATTEMPTS, fixSignature } from "../domain/fix-loop";
import type { Board } from "../domain/schemas";

const TEST_DB = `tosin4dev-test-fix-loop-${process.pid}-${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;

const { db, closeDb } = await import("./db");
const {
  applyRunCompletion,
  deliverFixFeedback,
  failingChecksWithOutput,
} = await import("./supervisor.server");

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

afterAll(async () => {
  await (await db()).dropDatabase();
  await closeDb();
});

describe("deliverFixFeedback", () => {
  beforeEach(async () => {
    const database = await db();
    await database.collection("runs").deleteMany({});
  });

  it("stops when the attempt budget is exhausted", async () => {
    const runId = await seedRun({ fixAttempts: MAX_FIX_ATTEMPTS });
    const { decision } = await deliverFixFeedback(runId, FAILING);
    expect(decision).toEqual({ retry: false, reason: "budget_exhausted" });
  });

  it("stops on a repeated signature before spending the remaining budget", async () => {
    const runId = await seedRun({
      fixAttempts: 1,
      lastFixSignature: fixSignature(FAILING),
    });
    const { decision } = await deliverFixFeedback(runId, FAILING);
    expect(decision).toEqual({ retry: false, reason: "repeated_failure" });
    const database = await db();
    const run = await database.collection("runs").findOne({ _id: new ObjectId(runId) });
    // Budget was NOT consumed by a decision that never delivered anything.
    expect(run?.fixAttempts).toBe(1);
  });

  it("does not mark feedback delivered when the run is parked awaiting input", async () => {
    const runId = await seedRun({ status: "awaiting_input" });
    const { decision } = await deliverFixFeedback(runId, FAILING);
    expect(decision).toEqual({ retry: false, reason: "suppressed" });
    const database = await db();
    const run = await database.collection("runs").findOne({ _id: new ObjectId(runId) });
    expect(run?.lastFixSignature).toBeNull();
    expect(run?.fixAttempts).toBe(0);
  });

  it("returns a retry decision and its signature without recording anything", async () => {
    const runId = await seedRun({});
    const { decision, signature } = await deliverFixFeedback(runId, FAILING);
    expect(decision).toEqual({ retry: true });
    expect(signature).toBe(fixSignature(FAILING));
    const database = await db();
    const run = await database.collection("runs").findOne({ _id: new ObjectId(runId) });
    // The decision is not a delivery: nothing is recorded until the send lands.
    expect(run?.fixAttempts).toBe(0);
    expect(run?.lastFixSignature).toBeNull();
  });

  it("does not report repeated_failure when two failures have unreadable logs", async () => {
    const database = await db();
    const runId = await seedRun({});
    // First failure: `lint` fails and its log cannot be read.
    const first = await failingChecksWithOutput([
      { key: "lint", exitCode: 1, outputRef: "/no/such/lint.1.log" },
    ]);
    expect(first.anyUnreadable).toBe(true);
    const { decision: firstDecision, signature } = await deliverFixFeedback(
      runId,
      first.loaded,
      first.anyUnreadable,
    );
    expect(firstDecision).toEqual({ retry: true });
    // The verification tail records the delivered attempt (CAS on fixAttempts)
    // only after a send lands; here we mirror that write between the two calls.
    await database.collection("runs").updateOne(
      { _id: new ObjectId(runId) },
      { $set: { fixAttempts: 1, lastFixSignature: signature } },
    );
    // Second, DIFFERENT failure: `lint` fails again and its log is unreadable
    // too. In the old code both contributed the empty string -> identical
    // {lint,1,""} tuples -> identical signatures -> a wrong repeated_failure for
    // a failure the agent has never seen. The fix skips the comparison whenever
    // any log was unreadable, so the loop keeps going.
    const second = await failingChecksWithOutput([
      { key: "lint", exitCode: 1, outputRef: "/no/such/lint.2.log" },
    ]);
    expect(second.anyUnreadable).toBe(true);
    const { decision: secondDecision } = await deliverFixFeedback(
      runId,
      second.loaded,
      second.anyUnreadable,
    );
    expect(secondDecision).toEqual({ retry: true });
  });
});

describe("fix-loop verification tail", () => {
  let repo: string;
  let branch: string;
  let baseSha: string;
  let board: Board;
  let runDir: string;
  let logFile: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "t4d-flrepo-"));
    execFileSync("git", ["init", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    await writeFile(join(repo, "README.md"), "x\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "init"]);
    baseSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    // A branch with one commit beyond base so verifyRun sees a new commit and a
    // failing check turns the verdict into verification_failed.
    branch = "t4d-fl-branch";
    execFileSync("git", ["-C", repo, "checkout", "-b", branch]);
    await writeFile(join(repo, "work.txt"), "y\n");
    execFileSync("git", ["-C", repo, "add", "work.txt"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "work"]);

    runDir = await mkdtemp(join(tmpdir(), "t4d-flrun-"));
    logFile = join(runDir, "run.log");
    await writeFile(
      join(runDir, "outcome.json"),
      JSON.stringify({ outcome: "completed" }),
    );

    board = {
      slug: `fixloop-${process.pid}-${Date.now()}`,
      name: "FixLoop",
      repoPath: repo,
      defaultBaseBranch: "main",
      checks: [{ key: "bad", label: "bad", command: ["false"], timeoutMs: 10_000 }],
    };
    const database = await db();
    const at = new Date().toISOString();
    await database.collection("boards").insertOne({
      ...board,
      createdAt: at,
      updatedAt: at,
    });
  });

  beforeEach(async () => {
    const database = await db();
    await database.collection("runs").deleteMany({});
    await database.collection("tickets").deleteMany({});
    await database.collection("evidence").deleteMany({});
  });

  afterAll(async () => {
    await Promise.all([
      rm(repo, { recursive: true, force: true }),
      rm(runDir, { recursive: true, force: true }),
    ]);
  });

  async function seedBlockedPathFixture(): Promise<{
    runId: string;
    ticketId: string;
  }> {
    const database = await db();
    const at = new Date().toISOString();
    const ticketId = new ObjectId();
    const runId = await seedRun({
      status: "running",
      branch,
      baseSha,
      workDir: repo,
      // A live lease owned by someone else: the retry claim cannot take it, so
      // sendContinueTurn returns false BEFORE any spawn, and the send never
      // happens. This is the spawn-free way to exercise the missed-claim path.
      executionLeaseId: "other-lease",
      executionLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await database.collection("tickets").insertOne({
      _id: ticketId,
      boardId: new ObjectId().toString(),
      seq: 1,
      title: "fix loop tail",
      type: "implement",
      status: "running",
      runner: "claude",
      spec: {
        intent: "verify the tail",
        scope: "",
        nonGoals: "",
        acceptance: [],
        links: [],
        risk: "low",
        approvedAt: at,
        approvedBy: "radan",
      },
      activeRunId: runId,
      prUrl: null,
      activity: [],
      dependsOn: [],
      createdAt: at,
      updatedAt: at,
    });
    return { runId, ticketId: ticketId.toString() };
  }

  it("leaves a run whose fix feedback was never sent unrecorded and blocked", async () => {
    const { runId, ticketId } = await seedBlockedPathFixture();
    const outcome = await applyRunCompletion(
      runId,
      ticketId,
      "execute",
      0,
      "out\n",
      logFile,
      null,
      board,
      runDir,
      new ObjectId().toString(),
    );
    expect(outcome).toBe("completed");
    const database = await db();
    const run = await database.collection("runs").findOne({ _id: new ObjectId(runId) });
    // The send never happened, so nothing was recorded: the budget and the
    // signature stay exactly as they were and re-fire cleanly next time.
    expect(run?.fixAttempts).toBe(0);
    expect(run?.lastFixSignature).toBeNull();
    // And the run reached the blocked path rather than lingering in `verifying`
    // invisible to the operator.
    expect(run?.status).toBe("failed");
    const ticket = await database.collection("tickets").findOne({ _id: new ObjectId(ticketId) });
    expect(ticket?.status).toBe("blocked");
  });
});
