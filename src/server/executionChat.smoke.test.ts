import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Collection, type Db, type WithId } from "mongodb";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Board, Run, Ticket } from "../domain/schemas";
import { ContinueExecutionInputSchema } from "./runs";

type BoardDoc = Board & { createdAt: string; updatedAt: string };
type TicketDoc = Ticket & { createdAt: string; updatedAt: string };
type RunDoc = Run & {
  pid: number | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

const TEST_DB = `tosin4dev-test-execution-chat-${process.pid}-${Date.now()}`;
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const ORIGINAL_OUTCOME = process.env.T4D_OUTCOME;
const ORIGINAL_MARKER = process.env.T4D_MARKER;
const ORIGINAL_ARGS = process.env.T4D_ARGS_FILE;
const ORIGINAL_EXIT = process.env.T4D_EXIT;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;
process.env.DISCORD_WEBHOOK_URL = "";

const { db, closeDb, ObjectId } = await import("./db");
const { continueExecution, dispatchRun, recoverOrphans, resumeRun } = await import(
  "./supervisor.server"
);
const { turnTailCore } = await import("./runs.server");

let database: Db;
let boards: Collection<BoardDoc>;
let tickets: Collection<TicketDoc>;
let runs: Collection<RunDoc>;
let repo: string;
let binDirectory: string;
let boardId: string;

const timestamp = () => new Date().toISOString();

// Fake `claude` runner: opts into capturing session id, echoes a per-call
// MARKER to stdout (so per-turn vs run-level log fan-out is observable), commits
// into the worktree (needed for the completed/verification path), and writes the
// T4D_OUTCOME snippet to the outcome path when one is supplied. When T4D_OUTCOME
// is absent it exits 0 writing no outcome.json — the `continued` case.
// T4D_ROTATE_SESSION makes a continue turn report a DIFFERENT session id than
// the dispatch turn, which is how the session-rotation guard is exercised.
async function writeRunner(): Promise<void> {
  const executable = join(binDirectory, "claude");
  await writeFile(
    executable,
    `#!/bin/sh
if [ -n "$T4D_ARGS_FILE" ]; then printf '%s\\n' "$@" > "$T4D_ARGS_FILE"; fi
SESSION=s-smoke
if [ -n "$T4D_ROTATE_SESSION" ]; then SESSION=s-continue; fi
printf '%s\\n' "{\\"type\\":\\"result\\",\\"session_id\\":\\"$SESSION\\",\\"result\\":\\"ok\\"}"
if [ -n "$T4D_MARKER" ]; then printf 'MARKER_%s\\n' "$T4D_MARKER"; fi
printf 'noise before summary\\n'
printf '%s\\n' '## SUMMARY'
printf '%s\\n' 'ok'
echo "artifact $$" > artifact.txt
git add -A
git commit -m "work" >/dev/null 2>&1
    if [ -n "$T4D_OUTCOME" ]; then
      printf '%s' "$T4D_OUTCOME" > "$T4D_OUTCOME_PATH"
    fi
    if [ -n "$T4D_EXIT" ]; then exit "$T4D_EXIT"; fi
    exit 0
`,
  );
  await chmod(executable, 0o755);
}

async function insertApproved(seq: number): Promise<string> {
  const at = timestamp();
  const result = await tickets.insertOne({
    boardId,
    seq,
    title: `execution chat ${seq}`,
    type: "implement",
    status: "approved",
    runner: "claude",
    spec: {
      intent: "exercise continue execution",
      scope: "",
      nonGoals: "",
      acceptance: [],
      links: [],
      risk: "low",
      approvedAt: at,
      approvedBy: "radan",
    },
    activeRunId: null,
    prUrl: null,
    activity: [],
    dependsOn: [],
    createdAt: at,
    updatedAt: at,
  });
  return result.insertedId.toString();
}

async function waitForRun(
  runId: string,
  expected: Run["status"],
  timeoutMs = 15_000,
): Promise<WithId<RunDoc>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await runs.findOne({ _id: new ObjectId(runId) });
    if (run?.status === expected) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} did not reach ${expected}`);
}

// Wait until `count` continue turns exist AND every continue turn carries a
// resolved outcome. Unlike status polling, this cannot observe the parked state
// that already held before the continue was issued.
async function waitForContinueTurn(
  runId: string,
  count: number,
  timeoutMs = 15_000,
): Promise<WithId<RunDoc>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await runs.findOne({ _id: new ObjectId(runId) });
    const continues =
      run?.turns.filter((turn) => turn.kind === "continue") ?? [];
    if (
      continues.length >= count &&
      continues.every((turn) => turn.outcome !== null)
    ) {
      return run!;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} continue turns did not resolve`);
}

// finishRun publishes a turn's outcome AFTER the run state that outcome implies,
// so polling on run status alone races the write. Wait for every turn to carry
// one — that is the point at which the run is fully settled.
async function waitForResolvedTurns(
  runId: string,
  timeoutMs = 15_000,
): Promise<WithId<RunDoc>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await runs.findOne({ _id: new ObjectId(runId) });
    if (
      run &&
      run.turns.length > 0 &&
      run.turns.every((turn) => turn.outcome !== null)
    ) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} turns did not all resolve`);
}

// Park a run at awaiting_input with a needs_input exchange, returning the run
// and the ticket id. This is the precondition every continue needs.
async function parkRun(
  seq: number,
): Promise<{ runId: string; ticketId: string; parked: WithId<RunDoc> }> {
  process.env.T4D_OUTCOME = JSON.stringify({
    outcome: "needs_input",
    question: "Which direction?",
  });
  const ticketId = await insertApproved(seq);
  const { runId } = await dispatchRun(ticketId, "execute");
  await waitForRun(runId, "awaiting_input");
  const parked = await waitForResolvedTurns(runId);
  // Settle the DISPATCH turn before handing the run back. Its outcome is
  // published after the park, so a test that installs an updateOne spy the
  // instant the run parks would otherwise intercept that trailing write instead
  // of the continue-turn write it means to freeze.
  expect(parked.executionSessionId).toBe("s-smoke");
  return { runId, ticketId, parked };
}

// Pause the first state-mutating write a resolving continue turn makes for the
// run. A turn resolves via one of: the `turns.$.outcome` write, the lease
// release (terminal outcomes), or the re-park (continued outcomes). Which one
// comes first is a property of the code under test — pausing on whichever
// arrives first lets a test move the lease / run / ticket underneath the turn
// at the earliest point it touches state, before any guard has a chance to run.
function pauseNextTurnResolution(runId: string): {
  reached: Promise<void>;
  release: () => void;
  spy: ReturnType<typeof vi.spyOn>;
} {
  const originalUpdateOne = Collection.prototype.updateOne;
  let reachedResolve!: () => void;
  let releaseResolve!: () => void;
  let paused = false;
  const reached = new Promise<void>((resolve) => {
    reachedResolve = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const spy = vi
    .spyOn(Collection.prototype, "updateOne")
    .mockImplementation(async function (
      this: Collection,
      filter,
      update,
      options,
    ) {
      const id = (filter as { _id?: { toString(): string } })._id;
      const set = (update as { $set?: Record<string, unknown> })
        .$set as Record<string, unknown> | undefined;
      const isOutcomeWrite = typeof set?.["turns.$.outcome"] === "string";
      const isLeaseMutation = set?.executionLeaseId === null;
      if (
        !paused &&
        this.collectionName === "runs" &&
        id?.toString() === runId &&
        (isOutcomeWrite || isLeaseMutation)
      ) {
        paused = true;
        reachedResolve();
        await release;
      }
      return originalUpdateOne.call(this, filter, update, options);
  });
  return { reached, release: releaseResolve, spy };
}

// Pause continueExecution the instant its claiming update lands: the run is
// already `running` but the continue turn has NOT been pushed yet. That window
// is exactly where a turn-completion rule derived from array position reports
// the PREVIOUS, already-finished turn as unfinished.
function pauseAfterContinueClaim(runId: string): {
  reached: Promise<void>;
  release: () => void;
  spy: ReturnType<typeof vi.spyOn>;
} {
  const originalUpdateOne = Collection.prototype.updateOne;
  let reachedResolve!: () => void;
  let releaseResolve!: () => void;
  let paused = false;
  const reached = new Promise<void>((resolve) => {
    reachedResolve = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const spy = vi
    .spyOn(Collection.prototype, "updateOne")
    .mockImplementation(async function (
      this: Collection,
      filter,
      update,
      options,
    ) {
      const set = (update as { $set?: Record<string, unknown> }).$set;
      const isClaim =
        typeof set?.executionLeaseId === "string" && set?.status === "running";
      const id = (filter as { _id?: { toString(): string } })._id;
      const result = await originalUpdateOne.call(this, filter, update, options);
      if (
        !paused &&
        this.collectionName === "runs" &&
        id?.toString() === runId &&
        isClaim
      ) {
        paused = true;
        reachedResolve();
        await release;
      }
      return result;
    });
  return { reached, release: releaseResolve, spy };
}

// A pid that is guaranteed to be dead: spawn a process, wait for it to exit.
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    child.once("error", reject);
    child.once("exit", () => resolve(child.pid ?? -1));
  });
}

const seedRunDoc = async (
  ticketId: string,
  overrides: Partial<RunDoc> = {},
): Promise<string> => {
  const at = timestamp();
  const runId = new ObjectId().toString();
  const doc: RunDoc = {
    ticketId,
    boardId,
    runner: "claude",
    phase: "execute",
    status: "running",
    workDir: `${repo}/.tosin4dev/worktrees/${runId}`,
    promptFile: `${repo}/.tosin4dev/runs/${runId}/prompt.md`,
    logFile: `${repo}/.tosin4dev/runs/${runId}/output.log`,
    stderrFile: `${repo}/.tosin4dev/runs/${runId}/stderr.log`,
    pid: null,
    exitCode: null,
    summary: null,
    branch: null,
    baseSha: null,
    verdict: null,
    failureKind: null,
    executionSessionId: "s-smoke",
    executionLeaseId: null,
    executionLeaseExpiresAt: null,
    parkedBy: "question" as const,
    awaitingQuestion: null,
    exchanges: [],
    turns: [],
    queuedAt: at,
    startedAt: at,
    finishedAt: null,
    ...overrides,
  };
  await runs.insertOne({
    _id: new ObjectId(runId),
    ...doc,
  });
  return runId;
};

describe("continueExecution", () => {
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "t4d-exec-chat-repo-"));
    binDirectory = await mkdtemp(join(tmpdir(), "t4d-exec-chat-bin-"));
    execFileSync("git", ["init", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    await writeFile(join(repo, "README.md"), "x\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "init"]);
    process.env.PATH = `${binDirectory}:${ORIGINAL_PATH ?? ""}`;
    await writeRunner();
    database = await db();
    boards = database.collection<BoardDoc>("boards");
    tickets = database.collection<TicketDoc>("tickets");
    runs = database.collection<RunDoc>("runs");
    const at = timestamp();
    const board = await boards.insertOne({
      slug: `exec-chat-${process.pid}-${Date.now()}`,
      name: "Execution Chat",
      repoPath: repo,
      defaultBaseBranch: "main",
      checks: [
        {
          key: "git",
          label: "git",
          command: ["git", "--version"],
          timeoutMs: 10_000,
        },
      ],
      createdAt: at,
      updatedAt: at,
    });
    boardId = board.insertedId.toString();
  });

  beforeEach(async () => {
    process.env.PATH = `${binDirectory}:${ORIGINAL_PATH ?? ""}`;
    delete process.env.T4D_OUTCOME;
    delete process.env.T4D_MARKER;
    delete process.env.T4D_ARGS_FILE;
    delete process.env.T4D_ROTATE_SESSION;
    delete process.env.T4D_EXIT;
    await writeRunner();
    await tickets.deleteMany({});
    await runs.deleteMany({});
  });

  afterAll(async () => {
    await database?.dropDatabase();
    await closeDb();
    process.env.PATH = ORIGINAL_PATH;
    process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;
    process.env.DISCORD_WEBHOOK_URL = ORIGINAL_WEBHOOK;
    process.env.T4D_OUTCOME = ORIGINAL_OUTCOME;
    process.env.T4D_MARKER = ORIGINAL_MARKER;
    process.env.T4D_ARGS_FILE = ORIGINAL_ARGS;
    process.env.T4D_EXIT = ORIGINAL_EXIT;
    await Promise.all([
      rm(repo, { recursive: true, force: true }),
      rm(binDirectory, { recursive: true, force: true }),
    ]);
  });

  describe("lease", () => {
    it("lets exactly one of two concurrent continues win and appends one turn", async () => {
      const { runId } = await parkRun(1);
      // A loser must be rejected while the winner is mid-flight: the winning
      // continue does not re-park until its process exits, so both claims race
      // the running state together.
      process.env.T4D_OUTCOME = JSON.stringify({
        outcome: "needs_input",
        question: "Second question?",
      });
      const results = await Promise.allSettled([
        continueExecution(runId, "A"),
        continueExecution(runId, "B"),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(rejected?.reason).toMatchObject({ code: "conflict" });

      const run = await waitForContinueTurn(runId, 1);
      const continues = run.turns.filter((turn) => turn.kind === "continue");
      expect(continues).toHaveLength(1);
      expect(continues[0]?.outcome).toBe("needs_input");
      await waitForRun(runId, "awaiting_input");
    }, 20_000);

    it("claims a run whose executionLeaseExpiresAt is in the past", async () => {
      const { runId } = await parkRun(2);
      // Stick a lease that has already run out directly on the parked run. The
      // atomic claim must still win because the lease is expired.
      const staleLeaseId = new ObjectId().toString();
      await runs.updateOne(
        { _id: new ObjectId(runId) },
        {
          $set: {
            executionLeaseId: staleLeaseId,
            executionLeaseExpiresAt: "2000-01-01T00:00:00.000Z",
          },
        },
      );

      process.env.T4D_OUTCOME = JSON.stringify({
        outcome: "needs_input",
        question: "After expiry?",
      });
      await expect(continueExecution(runId, "ok")).resolves.toBeUndefined();

      const run = await waitForContinueTurn(runId, 1);
      expect(run.awaitingQuestion).toBe("After expiry?");
      // The claim overwrote the stale id; the finish then cleared it, so it is
      // no longer the seeded value and the turn proves the claim landed.
      expect(run.executionLeaseId).not.toBe(staleLeaseId);
      expect(run.executionLeaseExpiresAt).toBeNull();
      await waitForRun(runId, "awaiting_input");
    }, 20_000);

    it("does not let a turn that lost its lease change the run", async () => {
      const { runId, ticketId } = await parkRun(3);
      process.env.T4D_OUTCOME = JSON.stringify({ outcome: "completed" });

      const pause = pauseNextTurnResolution(runId);
      const continuePromise = continueExecution(runId, "stale write");
      await pause.reached;
      try {
        // While the monitor is frozen at its first state write, the run's
        // lease moves underneath it — exactly the lost-lease condition. With a
        // `completed` outcome the stale turn would otherwise drive status,
        // verdict, evidence and the ticket, so the assertions below prove the
        // fencing held.
        await runs.updateOne(
          { _id: new ObjectId(runId) },
          { $set: { executionLeaseId: "someone-else-owns-the-run" } },
        );
        pause.release();
        await continuePromise;
        // If the stale turn slipped through, its finishRun would terminalize
        // (verify + succeed) in well under a second; give it a bounded window
        // to do so, then assert it never happened.
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const current = await runs.findOne({ _id: new ObjectId(runId) });
          if (current?.status === "succeeded" || current?.status === "failed") {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        pause.release();
        pause.spy.mockRestore();
      }

      const run = await runs.findOne({ _id: new ObjectId(runId) });
      // The turn's own outcome SHOULD be recorded (its id is unique)...
      const turn = run?.turns.find((t) => t.kind === "continue");
      expect(turn?.outcome).toBe("completed");
      // ...but the stale turn must NOT change run status, verdict, finishedAt,
      // or the ticket.
      expect(run?.verdict).toBeNull();
      expect(run?.finishedAt).toBeNull();
      expect(run?.status).not.toBe("succeeded");
      expect(run?.status).not.toBe("failed");
      const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
      expect(ticket?.status).not.toBe("review_ready");
    }, 20_000);
  });

  describe("turn records", () => {
    it("appends a continue turn with its own files and fans out to the run log", async () => {
      const { runId } = await parkRun(4);
      process.env.T4D_MARKER = "turn-bytes-42";
      process.env.T4D_OUTCOME = JSON.stringify({
        outcome: "needs_input",
        question: "Fan out?",
      });

      await continueExecution(runId, "go");
      const run = await waitForContinueTurn(runId, 1);

      const turn = run.turns.find((candidate) => candidate.kind === "continue");
      expect(turn).toBeDefined();
      expect(turn?.outcome).toBe("needs_input");
      expect(turn?.stdoutFile).toMatch(
        new RegExp(`${runId}/turns/${turn?.id}/stdout.log$`),
      );
      expect(turn?.stderrFile).toMatch(
        new RegExp(`${runId}/turns/${turn?.id}/stderr.log$`),
      );

      // Per-turn file received this turn's bytes...
      const perTurnStdout = await readFile(turn!.stdoutFile, "utf8");
      expect(perTurnStdout).toContain("MARKER_turn-bytes-42");
      // ...and the run-level log kept receiving them too.
      const runLog = await readFile(run.logFile, "utf8");
      expect(runLog).toContain("MARKER_turn-bytes-42");
      expect(runLog).toContain("noise before summary");

      // The dispatch turn's own file must NOT carry the continue marker: each
      // turn owns an isolated file while the run-level log accumulates all.
      const dispatchTurn = run.turns.find(
        (candidate) => candidate.kind === "dispatch",
      );
      expect(dispatchTurn).toBeDefined();
      const dispatchStdout = await readFile(dispatchTurn!.stdoutFile, "utf8");
      expect(dispatchStdout).not.toContain("MARKER_turn-bytes-42");
    }, 20_000);
  });

  describe("pinned capability", () => {
    it("passes the run's stored executionSessionId through --resume", async () => {
      const { runId, parked } = await parkRun(5);
      expect(parked.executionSessionId).toBe("s-smoke");

      const absoluteArgsFile = join(binDirectory, "captured-args.txt");
      process.env.T4D_ARGS_FILE = absoluteArgsFile;
      process.env.T4D_OUTCOME = JSON.stringify({ outcome: "completed" });

      await continueExecution(runId, "resume me");
      await waitForRun(runId, "succeeded");

      const captured = await readFile(absoluteArgsFile, "utf8");
      expect(captured).toContain("--resume");
      expect(captured).toContain("s-smoke");
      const run = await runs.findOne({ _id: new ObjectId(runId) });
      expect(run?.executionSessionId).toBe("s-smoke");
    }, 20_000);
  });

  describe("schema", () => {
    it("rejects extra keys on ContinueExecutionInput", () => {
      const base = { runId: new ObjectId().toString(), message: "x" };
      expect(() =>
        ContinueExecutionInputSchema.parse({ ...base, provider: "codex" }),
      ).toThrow();
      expect(() =>
        ContinueExecutionInputSchema.parse({ ...base, cwd: "/tmp" }),
      ).toThrow();
      expect(() =>
        ContinueExecutionInputSchema.parse({ ...base, sessionId: "s-1" }),
      ).toThrow();
      expect(() => ContinueExecutionInputSchema.parse(base)).not.toThrow();
    });
  });

  describe("outcomes", () => {
    it("records completed on the turn and verifies", async () => {
      const { runId } = await parkRun(6);
      process.env.T4D_OUTCOME = JSON.stringify({ outcome: "completed" });
      await continueExecution(runId, "finish it");
      await waitForRun(runId, "succeeded");
      // The declared outcome is published only after the state it implies is
      // durable, so synchronize on the turn's resolved outcome too.
      const run = await waitForContinueTurn(runId, 1);
      const turn = run.turns.find((candidate) => candidate.kind === "continue");
      expect(turn?.outcome).toBe("completed");
      expect(run.verdict).toBe("passed");
    }, 20_000);

    it("records needs_input on the turn and re-parks", async () => {
      const { runId } = await parkRun(7);
      process.env.T4D_OUTCOME = JSON.stringify({
        outcome: "needs_input",
        question: "Again?",
      });
      await continueExecution(runId, "more");
      const run = await waitForContinueTurn(runId, 1);
      const turn = run.turns.find((candidate) => candidate.kind === "continue");
      expect(turn?.outcome).toBe("needs_input");
      expect(run.awaitingQuestion).toBe("Again?");
      await waitForRun(runId, "awaiting_input");
    }, 20_000);

    it("records failed on the turn and fails the run", async () => {
      const { runId } = await parkRun(8);
      process.env.T4D_OUTCOME = JSON.stringify({
        outcome: "failed",
        reason: "declared failure",
      });
      await continueExecution(runId, "breaks");
      const run = await waitForContinueTurn(runId, 1);
      const turn = run.turns.find((candidate) => candidate.kind === "continue");
      expect(turn?.outcome).toBe("failed");
      expect(run.status).toBe("failed");
    }, 20_000);

    it("records continued when a runner exits 0 with no usable outcome", async () => {
      const { runId } = await parkRun(9);
      // No T4D_OUTCOME: the runner exits 0 without writing outcome.json.
      delete process.env.T4D_OUTCOME;
      await continueExecution(runId, "keep going");
      const run = await waitForContinueTurn(runId, 1);
      const turn = run.turns.find((candidate) => candidate.kind === "continue");
      expect(turn?.outcome).toBe("continued");
      expect(run.status).toBe("awaiting_input");
    }, 20_000);
  });

  describe("GATE 6 — continued vs completed verification", () => {
    it("does not verify a continued outcome and hands back to awaiting_input", async () => {
      const { runId, ticketId } = await parkRun(10);
      // No usable outcome + exit 0 == continued.
      delete process.env.T4D_OUTCOME;
      await continueExecution(runId, "keep going");
      const run = await waitForContinueTurn(runId, 1);
      const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });

      const turn = run.turns.find((candidate) => candidate.kind === "continue");
      expect(turn?.outcome).toBe("continued");
      expect(run.status).toBe("awaiting_input");
      expect(run.verdict).toBeNull();
      expect(run.finishedAt).toBeNull();
      expect(run.executionLeaseId).toBeNull();
      expect(run.executionLeaseExpiresAt).toBeNull();
      expect(ticket?.status).toBe("needs_input");
      expect(ticket?.activeRunId).toBe(runId);
    }, 20_000);

    it("verifies a completed outcome exactly like a normal resume", async () => {
      const { runId, ticketId } = await parkRun(11);
      process.env.T4D_OUTCOME = JSON.stringify({ outcome: "completed" });
      await continueExecution(runId, "done");
      await waitForRun(runId, "succeeded");
      // The declared outcome is published only after the state it implies is
      // durable, so synchronize on the turn's resolved outcome too.
      const run = await waitForContinueTurn(runId, 1);
      const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });

      expect(ticket?.status).toBe("review_ready");
      expect(run.verdict).toBe("passed");
      expect(run.finishedAt).not.toBeNull();
      const turn = run.turns.find((candidate) => candidate.kind === "continue");
      expect(turn?.outcome).toBe("completed");
    }, 20_000);
  });

  describe("loop and recovery", () => {
    it("lets the run be continued again immediately after a needs_input", async () => {
      const { runId } = await parkRun(12);
      process.env.T4D_OUTCOME = JSON.stringify({
        outcome: "needs_input",
        question: "Round two?",
      });
      await continueExecution(runId, "round one");
      const first = await waitForContinueTurn(runId, 1);
      const firstContinue = first.turns.find(
        (candidate) => candidate.kind === "continue",
      );
      expect(firstContinue?.outcome).toBe("needs_input");
      await waitForRun(runId, "awaiting_input");

      process.env.T4D_OUTCOME = JSON.stringify({
        outcome: "needs_input",
        question: "Round three?",
      });
      // Regression guard for the stale-lease bug: a live lease left behind
      // would reject this second claim with conflict.
      await expect(
        continueExecution(runId, "round two"),
      ).resolves.toBeUndefined();
      const second = await waitForContinueTurn(runId, 2);
      expect(
        second.turns.filter((candidate) => candidate.kind === "continue"),
      ).toHaveLength(2);
      expect(second.awaitingQuestion).toBe("Round three?");
      await waitForRun(runId, "awaiting_input");
    }, 20_000);

    it("releases the lease and re-parks when spawn fails", async () => {
      const { runId } = await parkRun(13);
      await rm(join(binDirectory, "claude"), { force: true });
      process.env.PATH = binDirectory;

      await expect(continueExecution(runId, "nope")).rejects.toMatchObject({
        code: "spawn_failed",
      });
      const run = await runs.findOne({ _id: new ObjectId(runId) });
      expect(run?.status).toBe("awaiting_input");
      expect(run?.executionLeaseId).toBeNull();
      expect(run?.executionLeaseExpiresAt).toBeNull();
    }, 20_000);

    it("clears an expired lease during recoverOrphans and leaves a leaseless run alone", async () => {
      const ticketId = await insertApproved(14);
      const dead = await deadPid();
      const staleLeaseId = new ObjectId().toString();
      const leasedRunId = await seedRunDoc(ticketId, {
        status: "running",
        pid: dead,
        executionLeaseId: staleLeaseId,
        executionLeaseExpiresAt: "2000-01-01T00:00:00.000Z",
      });
      const leaselessRunId = await seedRunDoc(ticketId, {
        status: "running",
        pid: dead,
        executionLeaseId: null,
        executionLeaseExpiresAt: null,
      });
      await tickets.updateOne(
        { _id: new ObjectId(ticketId) },
        { $set: { status: "running", activeRunId: leasedRunId } },
      );

      await expect(recoverOrphans()).resolves.toBeUndefined();

      const leased = await runs.findOne({ _id: new ObjectId(leasedRunId) });
      expect(leased?.status).toBe("failed");
      expect(leased?.failureKind).toBe("runner_exit");
      expect(leased?.executionLeaseId).toBeNull();
      expect(leased?.executionLeaseExpiresAt).toBeNull();

      const leaseless = await runs.findOne({
        _id: new ObjectId(leaselessRunId),
      });
      expect(leaseless?.status).toBe("failed");
      expect(leaseless?.executionLeaseId).toBeNull();
      expect(leaseless?.executionLeaseExpiresAt).toBeNull();
    }, 20_000);
  });

  describe("continue-turn guards", () => {
    it("persists the operator's continue message into the open exchange row", async () => {
      const { runId, parked } = await parkRun(15);
      const openBefore = (parked.exchanges ?? []).filter(
        (exchange) => exchange.answer === null,
      );
      expect(openBefore).toHaveLength(1);

      process.env.T4D_OUTCOME = JSON.stringify({ outcome: "completed" });
      await continueExecution(runId, "continue-with-this-message");
      await waitForRun(runId, "succeeded");

      const run = await runs.findOne({ _id: new ObjectId(runId) });
      const answered = (run?.exchanges ?? []).filter(
        (exchange) => exchange.answer === "continue-with-this-message",
      );
      expect(answered).toHaveLength(1);
      expect(answered[0]?.answeredAt).not.toBeNull();
    }, 20_000);

    it("keeps exactly one open exchange row across continued and needs_input turns", async () => {
      const { runId } = await parkRun(16);
      const openCount = async (): Promise<number> => {
        const run = await runs.findOne({ _id: new ObjectId(runId) });
        return (run?.exchanges ?? []).filter(
          (exchange) => exchange.answer === null,
        ).length;
      };
      expect(await openCount()).toBe(1);

      delete process.env.T4D_OUTCOME;
      await continueExecution(runId, "continue one");
      await waitForRun(runId, "awaiting_input");
      const first = await waitForContinueTurn(runId, 1);
      expect(first.turns.filter((turn) => turn.kind === "continue")).toHaveLength(
        1,
      );
      expect(await openCount()).toBe(1);

      process.env.T4D_OUTCOME = JSON.stringify({
        outcome: "needs_input",
        question: "Round again?",
      });
      await continueExecution(runId, "continue two");
      await waitForRun(runId, "awaiting_input");
      const second = await waitForContinueTurn(runId, 2);
      expect(
        second.turns.filter((turn) => turn.kind === "continue"),
      ).toHaveLength(2);
      expect(await openCount()).toBe(1);
    }, 20_000);

    it("never leaves awaitingQuestion blank after a continued re-park", async () => {
      const { runId } = await parkRun(17);
      delete process.env.T4D_OUTCOME;
      await continueExecution(runId, "keep going");
      const run = await waitForContinueTurn(runId, 1);
      const open = (run.exchanges ?? []).filter(
        (exchange) => exchange.answer === null,
      );
      expect(open).toHaveLength(1);
      expect(run.awaitingQuestion).toBeTruthy();
      expect(run.awaitingQuestion).toBe(open[0]?.question);
    }, 20_000);

    it("re-captures a rotated session id after a continued turn", async () => {
      const { runId } = await parkRun(18);
      // The fake runner reports a DIFFERENT session id on the continue turn;
      // the re-park must re-capture it so the NEXT turn resumes THIS session.
      process.env.T4D_ROTATE_SESSION = "1";
      delete process.env.T4D_OUTCOME;
      await continueExecution(runId, "rotate me");
      const run = await waitForContinueTurn(runId, 1);
      expect(run.executionSessionId).toBe("s-continue");
    }, 20_000);

    it("does not resurrect a run terminalized while its turn was in flight", async () => {
      const { runId } = await parkRun(19);
      delete process.env.T4D_OUTCOME;

      const pause = pauseNextTurnResolution(runId);
      const continuePromise = continueExecution(runId, "keep going");
      await pause.reached;
      try {
        const at = timestamp();
        await runs.updateOne(
          { _id: new ObjectId(runId) },
          { $set: { status: "failed", finishedAt: at } },
        );
        pause.release();
        await continuePromise;
        // The re-park guard must refuse the `status: "running"` term and leave
        // the terminalized run alone; give a resurrecting re-park a bounded
        // window to flip status before asserting it never did.
        const deadline = Date.now() + 750;
        while (Date.now() < deadline) {
          const current = await runs.findOne({ _id: new ObjectId(runId) });
          if (current?.status !== "failed") break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        pause.release();
        pause.spy.mockRestore();
      }

      const run = await runs.findOne({ _id: new ObjectId(runId) });
      expect(run?.status).toBe("failed");
      expect(run?.finishedAt).not.toBeNull();
    }, 20_000);

    it("clears activeRunId when the ticket moves underneath a continued turn", async () => {
      const { runId, ticketId } = await parkRun(20);
      delete process.env.T4D_OUTCOME;

      const pause = pauseNextTurnResolution(runId);
      const continuePromise = continueExecution(runId, "keep going");
      await pause.reached;
      try {
        const at = timestamp();
        await tickets.updateOne(
          { _id: new ObjectId(ticketId) },
          { $set: { status: "archived", updatedAt: at } },
        );
        pause.release();
        await continuePromise;
        // The ticket fallback must null the dangling activeRunId; poll until it
        // lands (or the timeout elapses, meaning the bug left it dangling).
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
          if (ticket?.activeRunId === null) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        pause.release();
        pause.spy.mockRestore();
      }

      const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
      expect(ticket?.activeRunId).toBeNull();
    }, 20_000);
  });

  describe("regression: rounds 3-4 — turn outcomes, eof, park kinds, compensation guards", () => {
    function tail(args: {
      runId: string;
      turnId: string;
      cursor: number;
    }): Promise<{ chunk: string; nextCursor: number; eof: boolean }> {
      return turnTailCore({ ...args, stream: "stdout", maxBytes: 20_000 });
    }

    it("keeps eof true on the dispatch turn THROUGH the continue claim window", async () => {
      const { runId } = await parkRun(21);

      // Tail the dispatch turn to its end on the parked run: eof must be true.
      const parkedRun = await runs.findOne({ _id: new ObjectId(runId) });
      const dispatchTurn = parkedRun!.turns.find((t) => t.kind === "dispatch")!;
      expect(
        (await tail({ runId, turnId: dispatchTurn.id, cursor: 0 })).eof,
      ).toBe(true);

      // Freeze continueExecution the moment its claim lands. This is the window
      // the previous fix missed: the run is `running` again and the continue
      // turn has not been appended, so the dispatch turn is BOTH last in the
      // array and on a running run. eof must not flip back to false here — a
      // client that stopped polling on the first eof would never resume, and a
      // client that saw eof go false would re-open a finished stream.
      delete process.env.T4D_OUTCOME;
      const pause = pauseAfterContinueClaim(runId);
      const continuePromise = continueExecution(runId, "keep going");
      await pause.reached;
      try {
        const midClaim = await runs.findOne({ _id: new ObjectId(runId) });
        expect(midClaim?.status).toBe("running");
        expect(midClaim?.turns).toHaveLength(1);
        expect(
          (await tail({ runId, turnId: dispatchTurn.id, cursor: 0 })).eof,
        ).toBe(true);
      } finally {
        pause.release();
        pause.spy.mockRestore();
      }
      await continuePromise;
      await waitForContinueTurn(runId, 1);

      // ...and still true once the continue turn has come and gone.
      expect(
        (await tail({ runId, turnId: dispatchTurn.id, cursor: 0 })).eof,
      ).toBe(true);
    }, 20_000);

    it("writes the dispatch turn's outcome when the run parks for input", async () => {
      const { runId } = await parkRun(25);
      const parked = await waitForResolvedTurns(runId);
      const dispatchTurn = parked.turns.find((t) => t.kind === "dispatch");
      expect(dispatchTurn?.outcome).toBe("needs_input");
      expect(parked.status).toBe("awaiting_input");
    }, 20_000);

    it("writes the resume turn's outcome when a resumed run completes", async () => {
      const { runId, ticketId } = await parkRun(26);
      process.env.T4D_OUTCOME = JSON.stringify({ outcome: "completed" });
      await resumeRun(runId, "carry on");
      await waitForRun(runId, "succeeded");
      const run = await waitForResolvedTurns(runId);

      const dispatchTurn = run.turns.find((t) => t.kind === "dispatch");
      const resumeTurn = run.turns.find((t) => t.kind === "resume");
      expect(dispatchTurn?.outcome).toBe("needs_input");
      expect(resumeTurn?.outcome).toBe("completed");
      // No turn may be left declaring itself still running on a finished run.
      expect(run.turns.filter((t) => t.outcome === null)).toHaveLength(0);
      const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
      expect(ticket?.status).toBe("review_ready");
    }, 20_000);

    it("writes the dispatch turn's outcome when the runner exits nonzero", async () => {
      const ticketId = await insertApproved(27);
      process.env.T4D_EXIT = "3";
      const { runId } = await dispatchRun(ticketId, "execute");
      await waitForRun(runId, "failed");
      const run = await waitForResolvedTurns(runId);
      expect(run.turns.find((t) => t.kind === "dispatch")?.outcome).toBe(
        "failed",
      );
    }, 20_000);

    it("a continued-park run rejects resumeRun with conflict and does NOT fail", async () => {
      const { runId, ticketId } = await parkRun(22);
      // No T4D_OUTCOME → the continue will resolve as `continued` (re-park).
      delete process.env.T4D_OUTCOME;
      await continueExecution(runId, "keep going");
      await waitForContinueTurn(runId, 1);
      const parked = await waitForRun(runId, "awaiting_input");
      expect(parked.parkedBy).toBe("continued");

      // resumeRun must reject a continued-park run with conflict...
      await expect(resumeRun(runId, "any answer")).rejects.toMatchObject({
        code: "conflict",
      });
      // ...and must NOT have failed the run or blocked the ticket.
      const run = await runs.findOne({ _id: new ObjectId(runId) });
      expect(run?.status).toBe("awaiting_input");
      const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
      expect(ticket?.status).toBe("needs_input");
    }, 20_000);

    it("terminalizes the run when the ticket moves underneath a continued re-park", async () => {
      const { runId, ticketId } = await parkRun(23);
      delete process.env.T4D_OUTCOME;

      const pause = pauseNextTurnResolution(runId);
      const continuePromise = continueExecution(runId, "keep going");
      await pause.reached;
      try {
        // Archive the ticket while the continue turn is in flight — the re-park's
        // ticket update will match nothing, and the run must be terminalized (not
        // left stranded at awaiting_input).
        const at = timestamp();
        await tickets.updateOne(
          { _id: new ObjectId(ticketId) },
          { $set: { status: "archived", updatedAt: at } },
        );
        pause.release();
        await continuePromise;

        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const run = await runs.findOne({ _id: new ObjectId(runId) });
          if (run?.status === "failed") break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        pause.release();
        pause.spy.mockRestore();
      }

      const run = await runs.findOne({ _id: new ObjectId(runId) });
      expect(run?.status).toBe("failed");
      expect(run?.finishedAt).not.toBeNull();
      expect(run?.failureKind).toBe("runner_exit");
    }, 20_000);

    it("restores a `continued` park as continued, not as a question park", async () => {
      const { runId } = await parkRun(28);
      // First continue resolves as `continued` (no outcome.json, exit 0).
      delete process.env.T4D_OUTCOME;
      await continueExecution(runId, "keep going");
      await waitForContinueTurn(runId, 1);
      expect((await waitForRun(runId, "awaiting_input")).parkedBy).toBe(
        "continued",
      );

      // Second continue fails to spawn, so the compensation path re-parks the
      // run. It must restore the park KIND, not downgrade it to a question park.
      await rm(join(binDirectory, "claude"), { force: true });
      process.env.PATH = binDirectory;
      try {
        await expect(continueExecution(runId, "again")).rejects.toMatchObject({
          code: "spawn_failed",
        });
      } finally {
        await writeRunner();
        process.env.PATH = `${binDirectory}:${ORIGINAL_PATH ?? ""}`;
      }

      const run = await runs.findOne({ _id: new ObjectId(runId) });
      expect(run?.status).toBe("awaiting_input");
      expect(run?.parkedBy).toBe("continued");
      // The downgrade's real damage: resumeRun would accept the run and, being
      // fail-closed, destroy it. The guard must still hold after compensation.
      await expect(resumeRun(runId, "any answer")).rejects.toMatchObject({
        code: "conflict",
      });
      const after = await runs.findOne({ _id: new ObjectId(runId) });
      expect(after?.status).toBe("awaiting_input");
    }, 20_000);

    it("does not drag the ticket to needs_input when the run was terminalized", async () => {
      const { runId, ticketId } = await parkRun(29);
      await rm(join(binDirectory, "claude"), { force: true });
      process.env.PATH = binDirectory;

      const originalUpdateOne = Collection.prototype.updateOne;
      let reachedResolve!: () => void;
      let proceedResolve!: () => void;
      const reached = new Promise<void>((r) => { reachedResolve = r; });
      const proceed = new Promise<void>((r) => { proceedResolve = r; });
      let first = true;
      const spy = vi.spyOn(Collection.prototype, "updateOne").mockImplementation(
        async function (this: Collection, filter, update, options) {
          const res = await originalUpdateOne.call(this, filter, update, options);
          if (
            first &&
            String((filter as Record<string, unknown>)?._id) === runId &&
            this.collectionName === "runs"
          ) {
            first = false;
            reachedResolve();
            await proceed;
          }
          return res;
        },
      );

      try {
        const promise = resumeRun(runId, "any answer");
        await reached;
        // While the resume is paused after its claim, the run dies and the
        // ticket is moved somewhere that is NOT needs_input while still naming
        // the run. Restoring the ticket half here would leave `needs_input` +
        // activeRunId on a dead run — a state with no legal transition out.
        const at = timestamp();
        await runs.updateOne(
          { _id: new ObjectId(runId), status: "running" },
          {
            $set: {
              status: "failed",
              failureKind: "runner_exit",
              finishedAt: at,
            },
          },
        );
        await tickets.updateOne(
          { _id: new ObjectId(ticketId) },
          { $set: { status: "blocked", updatedAt: at } },
        );
        proceedResolve();
        await expect(promise).rejects.toMatchObject({ code: "spawn_failed" });
      } finally {
        proceedResolve();
        spy.mockRestore();
        await writeRunner();
        process.env.PATH = `${binDirectory}:${ORIGINAL_PATH ?? ""}`;
      }

      const run = await runs.findOne({ _id: new ObjectId(runId) });
      expect(run?.status).toBe("failed");
      const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
      expect(ticket?.status).toBe("blocked");
    }, 20_000);

    it("notifies blocked — not awaiting-input — when the ticket moves underneath a re-park", async () => {
      const { runId, ticketId } = await parkRun(30);
      delete process.env.T4D_OUTCOME;

      const bodies: string[] = [];
      process.env.DISCORD_WEBHOOK_URL = "https://discord.invalid/webhook";
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (_input, init) => {
          bodies.push(String((init as RequestInit | undefined)?.body ?? ""));
          return new Response("", { status: 204 });
        });
      const pause = pauseNextTurnResolution(runId);
      const continuePromise = continueExecution(runId, "keep going");
      await pause.reached;
      try {
        const at = timestamp();
        await tickets.updateOne(
          { _id: new ObjectId(ticketId) },
          { $set: { status: "archived", updatedAt: at } },
        );
        pause.release();
        await continuePromise;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          if (bodies.some((body) => body.includes("blocked"))) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        pause.release();
        pause.spy.mockRestore();
        fetchSpy.mockRestore();
        process.env.DISCORD_WEBHOOK_URL = "";
      }

      // The operator must not be told a terminalized run is awaiting input.
      expect(bodies.some((body) => body.includes("awaiting input"))).toBe(false);
      expect(bodies.some((body) => body.includes("blocked"))).toBe(true);
    }, 20_000);

    it("releases the lease when the continued re-park loses its CAS", async () => {
      const { runId } = await parkRun(31);
      delete process.env.T4D_OUTCOME;

      const pause = pauseNextTurnResolution(runId);
      const continuePromise = continueExecution(runId, "keep going");
      await pause.reached;
      try {
        // Terminalize the run so the re-park's `status: "running"` term misses.
        const at = timestamp();
        await runs.updateOne(
          { _id: new ObjectId(runId) },
          { $set: { status: "failed", finishedAt: at } },
        );
        pause.release();
        await continuePromise;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const current = await runs.findOne({ _id: new ObjectId(runId) });
          if (current?.executionLeaseId === null) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        pause.release();
        pause.spy.mockRestore();
      }

      const run = await runs.findOne({ _id: new ObjectId(runId) });
      // A held lease rejects every future continue with "run is already
      // executing" until a process restart runs recoverOrphans.
      expect(run?.executionLeaseId).toBeNull();
      expect(run?.executionLeaseExpiresAt).toBeNull();
      expect(run?.pid).toBeNull();
      // The turn still resolved, so nothing renders it as forever-running.
      expect(run?.turns.find((t) => t.kind === "continue")?.outcome).toBe(
        "continued",
      );
    }, 20_000);

    it("never opens a second exchange row when one appears during a re-park", async () => {
      const { runId } = await parkRun(32);
      delete process.env.T4D_OUTCOME;

      const pause = pauseNextTurnResolution(runId);
      const continuePromise = continueExecution(runId, "keep going");
      await pause.reached;
      try {
        // A concurrent park slips an open row in before the re-park lands. The
        // re-park must refuse rather than manufacture a SECOND open row.
        await runs.updateOne(
          { _id: new ObjectId(runId) },
          {
            $push: {
              exchanges: {
                v: 1 as const,
                at: timestamp(),
                question: "Concurrent park",
                handoff: null,
                answer: null,
                answeredAt: null,
              },
            },
          },
        );
        pause.release();
        await continuePromise;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const current = await runs.findOne({ _id: new ObjectId(runId) });
          if (
            current?.turns.find((t) => t.kind === "continue")?.outcome !== null
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        pause.release();
        pause.spy.mockRestore();
      }

      const run = await runs.findOne({ _id: new ObjectId(runId) });
      const open = (run?.exchanges ?? []).filter(
        (exchange) => exchange.answer === null,
      );
      expect(open).toHaveLength(1);
      expect(open[0]?.question).toBe("Concurrent park");
    }, 20_000);

    it("refuses a continue whose parked question changed between read and claim", async () => {
      const ticketId = await insertApproved(33);
      // A legacy-shaped parked run: no exchange rows at all, so the claim has no
      // row to pin and must fall back to pinning their ABSENCE plus the question.
      const runId = await seedRunDoc(ticketId, {
        status: "awaiting_input",
        parkedBy: "question",
        awaitingQuestion: "Legacy question",
        exchanges: [],
      });
      await tickets.updateOne(
        { _id: new ObjectId(ticketId) },
        { $set: { status: "needs_input", activeRunId: runId } },
      );

      const originalUpdateOne = Collection.prototype.updateOne;
      let sniped = false;
      const spy = vi.spyOn(Collection.prototype, "updateOne").mockImplementation(
        async function (this: Collection, filter, update, options) {
          const set = (update as { $set?: Record<string, unknown> }).$set;
          if (
            !sniped &&
            this.collectionName === "runs" &&
            String((filter as Record<string, unknown>)?._id) === runId &&
            typeof set?.executionLeaseId === "string"
          ) {
            sniped = true;
            // A concurrent park re-parks the run on a DIFFERENT question in the
            // gap between our snapshot and this claim. Answering it would land
            // the operator's message on a question they never saw.
            await originalUpdateOne.call(
              this,
              { _id: new ObjectId(runId) },
              { $set: { awaitingQuestion: "Sniped question" } },
              undefined,
            );
          }
          return originalUpdateOne.call(this, filter, update, options);
        },
      );

      try {
        await expect(continueExecution(runId, "answer")).rejects.toMatchObject({
          code: "conflict",
        });
      } finally {
        spy.mockRestore();
      }

      const run = await runs.findOne({ _id: new ObjectId(runId) });
      expect(run?.status).toBe("awaiting_input");
      expect(run?.executionLeaseId).toBeNull();
    }, 20_000);

    it("restoreParkedResume does not resurrect a terminalized run", async () => {
      const { runId } = await parkRun(24);
      // Delete the runner binary so spawn will fail, hitting the restore path.
      await rm(join(binDirectory, "claude"), { force: true });
      process.env.PATH = binDirectory;

      // Spy to interleave: terminalize the run between the resume claim and
      // the spawn-failure restoreParkedResume call.
      const originalUpdateOne = Collection.prototype.updateOne;
      let reachedResolve!: () => void;
      let proceedResolve!: () => void;
      const reached = new Promise<void>((r) => { reachedResolve = r; });
      const proceed = new Promise<void>((r) => { proceedResolve = r; });
      let first = true;
      const spy = vi.spyOn(Collection.prototype, "updateOne").mockImplementation(
        async function (this: Collection, filter, update, options) {
          const res = await originalUpdateOne.call(this, filter, update, options);
          if (
            first &&
            String((filter as Record<string, unknown>)?._id) === runId &&
            this.collectionName === "runs"
          ) {
            first = false;
            reachedResolve();
            await proceed;
          }
          return res;
        },
      );

      try {
        const promise = resumeRun(runId, "any answer");
        await reached;
        // While resumeRun is paused after claiming the run, terminalize it.
        const at = timestamp();
        await runs.updateOne(
          { _id: new ObjectId(runId), status: "running" },
          {
            $set: {
              status: "failed",
              failureKind: "runner_exit",
              finishedAt: at,
            },
          },
        );
        proceedResolve();
        await expect(promise).rejects.toMatchObject({ code: "spawn_failed" });

        const run = await runs.findOne({ _id: new ObjectId(runId) });
        expect(run?.status).toBe("failed");
        expect(run?.finishedAt).not.toBeNull();
      } finally {
        spy.mockRestore();
        await writeRunner();
        process.env.PATH = `${binDirectory}:${ORIGINAL_PATH ?? ""}`;
      }
    }, 20_000);
  });
});
