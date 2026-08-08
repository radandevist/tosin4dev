import { execFileSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_FIX_ATTEMPTS, fixSignature } from "../domain/fix-loop";
import type { Board } from "../domain/schemas";

const TEST_DB = `tosin4dev-test-fix-loop-${process.pid}-${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;

// A real, billable `claude` sits on PATH in this environment, and the retry
// test deliberately reaches a spawn. Stub PATH so the spawn fails with ENOENT
// and never launches the real agent. The stub PREPENDS an empty bin dir to a
// copy of PATH that has had every directory holding an executable `claude`
// filtered out — replacing PATH outright would also hide `git` and `node`,
// which the head-SHA guard and the repo fixture shell out to. Prepending alone
// is NOT sufficient: Node resolves the spawned command against the whole PATH,
// so an empty first entry still falls through to the real binary.
const ORIGINAL_PATH = process.env.PATH;

function isExecutable(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// A filtered copy of the original PATH, minus any directory that could resolve
// `claude`. The retry test's spawn must see ENOENT; `git` and `node` keep their
// real homes.
function stubPath(binDirectory: string): string {
  const filtered = (ORIGINAL_PATH ?? "")
    .split(":")
    .filter((dir) => dir && !isExecutable(`${dir}/claude`));
  return [binDirectory, ...filtered].join(":");
}

const { db, closeDb } = await import("./db");
const {
  applyRunCompletion,
  deliverFixFeedback,
  failingChecksWithOutput,
} = await import("./supervisor.server");

const FAILING = [{ key: "lint", exitCode: 1, output: "error: unused var" }];

async function seedEvidence(
  runId: string,
  commitSha: string,
  over: Record<string, unknown> = {},
): Promise<void> {
  const database = await db();
  await database.collection("evidence").insertOne({
    runId,
    ticketId: new ObjectId().toString(),
    commitSha,
    commitRef: "tosin4dev/run/x",
    checks: [],
    verdict: "failed",
    createdAt: "2026-08-07T00:00:00.000Z",
    ...over,
  });
}

// A real temp repo whose HEAD is a reachable commit, so the guard's git read
// exercises the actual `rev-parse` rather than a stub.
async function initFixRepo(): Promise<{ repo: string; sha: string }> {
  const repo = await mkdtemp(join(tmpdir(), "t4d-fixrepo-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  await writeFile(join(repo, "README.md"), "x\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "root"]);
  const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  return { repo, sha };
}

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

let binDirectory: string;

beforeAll(async () => {
  binDirectory = await mkdtemp(join(tmpdir(), "t4d-fixbin-"));
});

beforeEach(async () => {
  process.env.PATH = stubPath(binDirectory);
});

afterAll(async () => {
  await (await db()).dropDatabase();
  await closeDb();
  process.env.PATH = ORIGINAL_PATH;
  await rm(binDirectory, { recursive: true, force: true });
});

describe("deliverFixFeedback", () => {
  beforeEach(async () => {
    const database = await db();
    await database.collection("runs").deleteMany({});
    await database.collection("evidence").deleteMany({});
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

  it("does not retry a run with no captured provider session", async () => {
    // A retry resumes the SAME provider session. Without a captured id there is
    // nothing to resume, so the failure is not fixable by a retry — fail closed
    // BEFORE the budget is spent or any send is attempted.
    const runId = await seedRun({ executionSessionId: null });
    const { decision } = await deliverFixFeedback(runId, FAILING);
    expect(decision).toEqual({ retry: false, reason: "not_retryable" });
    const database = await db();
    const run = await database.collection("runs").findOne({ _id: new ObjectId(runId) });
    expect(run?.fixAttempts).toBe(0);
    expect(run?.lastFixSignature).toBeNull();
  });

  it("still retries when the branch tip matches the verified commit", async () => {
    const { repo, sha } = await initFixRepo();
    try {
      const runId = await seedRun({ workDir: repo });
      await seedEvidence(runId, sha);
      const { decision } = await deliverFixFeedback(runId, FAILING);
      // The tip the checks ran against is still HEAD, so the failures describe
      // a live commit: hand them back to the agent.
      expect(decision).toEqual({ retry: true });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("suppresses when the branch tip has moved past the verified commit", async () => {
    const { repo, sha } = await initFixRepo();
    try {
      // A second commit moves HEAD: the failures describe a commit that no
      // longer exists, and the guard must not hand them to the agent.
      await writeFile(join(repo, "later.txt"), "y\n");
      execFileSync("git", ["-C", repo, "add", "later.txt"]);
      execFileSync("git", ["-C", repo, "commit", "-m", "moved"]);
      const runId = await seedRun({ workDir: repo });
      await seedEvidence(runId, sha);
      const { decision } = await deliverFixFeedback(runId, FAILING);
      expect(decision).toEqual({ retry: false, reason: "suppressed" });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("suppresses when the tip cannot be read", async () => {
    // An evidence row exists but workDir is not a git repository, so the git
    // read fails. An unknown tip is not evidence the commit is still there, so
    // the guard fails CLOSED: suppress rather than deliver.
    const notARepo = await mkdtemp(join(tmpdir(), "t4d-notrepo-"));
    try {
      const runId = await seedRun({ workDir: notARepo });
      await seedEvidence(runId, "0".repeat(40));
      const { decision } = await deliverFixFeedback(runId, FAILING);
      expect(decision).toEqual({ retry: false, reason: "suppressed" });
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
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

  async function seedRetryFixture(): Promise<{
    runId: string;
    ticketId: string;
    promptFile: string;
  }> {
    const database = await db();
    const at = new Date().toISOString();
    const ticketId = new ObjectId();
    const promptFile = join(runDir, "retry-prompt.txt");
    const runId = await seedRun({
      status: "running",
      branch,
      baseSha,
      workDir: repo,
      // A retry resumes the SAME provider session; give the run one so the
      // decision is `retry: true` and the send path is reached.
      executionSessionId: "sess-retry",
      // The lease is FREE: the claim must win so the send is actually attempted.
      executionLeaseId: null,
      executionLeaseExpiresAt: null,
      // A unique prompt path proves the send got past the lease claim (which
      // returns before any write) and into the spawn prep, where the prompt is
      // written. The 4a tail test's foreign lease never reaches this write.
      promptFile,
    });
    await database.collection("tickets").insertOne({
      _id: ticketId,
      boardId: new ObjectId().toString(),
      seq: 1,
      title: "fix loop retry",
      type: "implement",
      status: "running",
      runner: "claude",
      spec: {
        intent: "verify the retry",
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
    return { runId, ticketId: ticketId.toString(), promptFile };
  }

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

  it("drives the retry branch to an attempted send that lands blocked on spawn failure", async () => {
    const { runId, ticketId, promptFile } = await seedRetryFixture();
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
    // THE SEND WAS REACHED, not short-circuited at a guard. sendContinueTurn
    // writes the prompt ONLY after the lease claim wins; a lost claim (the 4a
    // tail test's fixture) returns false before any write, and a suppressed
    // decision never reaches the send at all. The stubbed PATH then makes the
    // actual spawn fail with ENOENT.
    const prompt = await readFile(promptFile, "utf8");
    expect(prompt).toContain("acceptance checks");
    // The failed send landed in the blocked tail: the run failed visibly rather
    // than lingering in `verifying`, and the ticket is blocked.
    expect(run?.status).toBe("failed");
    const ticket = await database.collection("tickets").findOne({ _id: new ObjectId(ticketId) });
    expect(ticket?.status).toBe("blocked");
    // Nothing was recorded: the send never delivered, so the budget and the
    // signature stay exactly as they were and re-fire cleanly next time.
    expect(run?.fixAttempts).toBe(0);
    expect(run?.lastFixSignature).toBeNull();
  });
});
