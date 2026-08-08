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

// A turn's outcome is now folded into the SAME update as the state change it
// describes, so a run seen `awaiting_input` already carries it — but not every
// path folds: the compensation paths stamp with a trailing recordTurnOutcome.
// Waiting for every turn to carry an outcome is the one settle point that holds
// for all of them. It is NOT the run's last write: finishRun's trailing backstop
// still follows (see pauseNextTurnResolution).
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
  // Settle the DISPATCH turn before handing the run back — its park, its ticket
  // transition and its outcome are all public by the time this returns. One
  // write still trails it (finishRun's backstop), which is why
  // pauseNextTurnResolution must not match that write's shape.
  expect(parked.executionSessionId).toBe("s-smoke");
  return { runId, ticketId, parked };
}

// Pause the first STATE-MUTATING write a resolving continue turn makes for the
// run: the lease release (terminal outcomes) or the re-park, which nulls the
// lease and folds the turn's outcome into the same update (continued outcomes).
// Pausing there lets a test move the lease / run / ticket underneath the turn at
// the earliest point it touches state, before any guard has a chance to run.
//
// The bare `turns.$.outcome` shape is deliberately NOT matched. That is
// finishRun's trailing backstop, a no-op once the folded stamp has landed — and
// since the outcome became atomic with the state it describes, waitForResolvedTurns
// returns one write BEFORE it. So parkRun hands back a run whose dispatch turn
// still has that write in flight, and a helper matching it pauses on the previous
// turn's backstop instead of the continue turn's first write: the sabotage then
// lands before the continue turn has spawned and the test proves nothing.
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
      const isFoldedOutcomeWrite =
        typeof set?.["turns.$[t].outcome"] === "string";
      const isLeaseMutation = set?.executionLeaseId === null;
      if (
        !paused &&
        this.collectionName === "runs" &&
        id?.toString() === runId &&
        (isLeaseMutation || isFoldedOutcomeWrite)
      ) {
        paused = true;
        reachedResolve();
        await release;
      }
      return originalUpdateOne.call(this, filter, update, options);
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
    fixAttempts: 0,
    lastFixSignature: null,
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
    const terminal = Date.now() + 5_000;
    const pendingStatuses: Array<
      "queued" | "running" | "verifying" | "awaiting_input"
    > = [
      "queued",
      "running",
      "verifying",
      "awaiting_input",
    ];
    while (Date.now() < terminal) {
      const pending = await runs.countDocuments({
        status: { $in: pendingStatuses },
      });
      if (pending === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
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

  // eof itself is exercised in turnTail.smoke.test.ts, which seeds run documents
  // directly and can therefore assert eof FALSE where a position-derived rule
  // would wrongly say true. An end-to-end eof assertion here could only ever
  // assert eof TRUE, which every candidate rule satisfies — it would not
  // discriminate. What this file owns is the writing of turn outcomes.
  describe("regression: rounds 3-5 — turn outcomes, park kinds, compensation guards", () => {
    // Pause a spawn-path turn the instant its run row goes live (pid + cleared
    // question) and run `sabotage` there. That is the exact window between the
    // run write and the ticket transition, where an abandoned turn row is born.
    function sabotageAfterRunStarted(
      runId: string,
      sabotage: () => Promise<void>,
    ): ReturnType<typeof vi.spyOn> {
      const originalUpdateOne = Collection.prototype.updateOne;
      let armed = true;
      return vi.spyOn(Collection.prototype, "updateOne").mockImplementation(
        async function (this: Collection, filter, update, options) {
          const set = (update as { $set?: Record<string, unknown> }).$set;
          const isRunStarted =
            armed &&
            this.collectionName === "runs" &&
            String((filter as Record<string, unknown>)?._id) === runId &&
            !!set &&
            "pid" in set &&
            "awaitingQuestion" in set;
          const result = await originalUpdateOne.call(
            this,
            filter,
            update,
            options,
          );
          if (isRunStarted) {
            armed = false;
            await sabotage();
          }
          return result;
        },
      );
    }

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

    it("leaves no unresolved turn when a continue's ticket transition misses", async () => {
      const { runId, ticketId } = await parkRun(34);
      delete process.env.T4D_OUTCOME;

      const spy = sabotageAfterRunStarted(runId, async () => {
        // Move the ticket so the transition that follows matches nothing. The
        // throw takes continueExecution into its compensation path, which knows
        // nothing about turns.
        await tickets.updateOne(
          { _id: new ObjectId(ticketId) },
          { $set: { status: "blocked", updatedAt: timestamp() } },
        );
      });
      try {
        await expect(
          continueExecution(runId, "keep going"),
        ).rejects.toMatchObject({ code: "spawn_failed" });
      } finally {
        spy.mockRestore();
      }

      const run = await runs.findOne({ _id: new ObjectId(runId) });
      expect(run?.status).toBe("awaiting_input");
      // A turn row nothing will ever close renders "running" forever and flips
      // every later turn's eof true → false → true.
      expect(run?.turns.filter((t) => t.outcome === null)).toHaveLength(0);
      expect(run?.turns).toHaveLength(1);
    }, 20_000);

    it("leaves no unresolved turn when a resume's ticket transition misses", async () => {
      const { runId, ticketId } = await parkRun(35);
      process.env.T4D_OUTCOME = JSON.stringify({ outcome: "completed" });

      const spy = sabotageAfterRunStarted(runId, async () => {
        await tickets.updateOne(
          { _id: new ObjectId(ticketId) },
          { $set: { status: "blocked", updatedAt: timestamp() } },
        );
      });
      try {
        await expect(resumeRun(runId, "carry on")).rejects.toMatchObject({
          code: "spawn_failed",
        });
      } finally {
        spy.mockRestore();
      }

      const run = await runs.findOne({ _id: new ObjectId(runId) });
      expect(run?.status).toBe("awaiting_input");
      expect(run?.turns.filter((t) => t.outcome === null)).toHaveLength(0);
      expect(run?.turns).toHaveLength(1);
    }, 20_000);

    it("publishes the dispatch turn's outcome no later than the park it describes", async () => {
      process.env.T4D_OUTCOME = JSON.stringify({
        outcome: "needs_input",
        question: "Atomic?",
      });
      const ticketId = await insertApproved(36);
      // A foreign run whose turn is still unresolved, standing in for an earlier
      // test's in-flight monitor.
      const strayTurnId = new ObjectId().toString();
      const strayRunId = await seedRunDoc(await insertApproved(42), {
        turns: [
          {
            v: 1 as const,
            id: strayTurnId,
            index: 0,
            at: timestamp(),
            kind: "dispatch" as const,
            outcome: null,
            stdoutFile: `${repo}/.tosin4dev/turns/${strayTurnId}/stdout.log`,
            stderrFile: `${repo}/.tosin4dev/turns/${strayTurnId}/stderr.log`,
          },
        ],
      });

      // finishRun's trailing write is the LAST thing the park does. Snapshot the
      // run as it stands immediately before it: if the outcome is not already
      // there, then the park was publicly visible with a null outcome, and a
      // continue claim landing in that window reads eof:false for a finished
      // turn.
      const snapshots: Array<{
        status: string | undefined;
        dispatchOutcome: string | null | undefined;
        ticketStatus: string | undefined;
      }> = [];
      const originalUpdateOne = Collection.prototype.updateOne;
      const spy = vi.spyOn(Collection.prototype, "updateOne").mockImplementation(
        async function (this: Collection, filter, update, options) {
          const set = (update as { $set?: Record<string, unknown> }).$set;
          if (this.collectionName === "runs" && set && "turns.$.outcome" in set) {
            const id = (filter as { _id?: unknown })._id;
            const doc = await runs.findOne({ _id: id } as never);
            // Scope the snapshot to THIS test's run. The spy sees every run, and
            // a monitor still in flight from an earlier test lands its own
            // trailing outcome write in this window — a doc already deleted by
            // beforeEach at that, which would push a snapshot of `undefined` and
            // break the length assertion below. Match on the ticket rather than
            // the run id: runId is only bound after dispatchRun returns, which is
            // after this spy is armed.
            if (doc?.ticketId !== ticketId) {
              return originalUpdateOne.call(this, filter, update, options);
            }
            const ticket = await tickets.findOne({
              _id: new ObjectId(doc.ticketId),
            });
            snapshots.push({
              status: doc?.status,
              dispatchOutcome: doc?.turns.find((t) => t.kind === "dispatch")
                ?.outcome,
              ticketStatus: ticket?.status,
            });
          }
          return originalUpdateOne.call(this, filter, update, options);
        },
      );

      let runId: string;
      try {
        // A monitor still in flight from an EARLIER test lands its own trailing
        // outcome write in this window; stand one in explicitly so the scoping
        // above is pinned rather than left to timing.
        await runs.updateOne(
          {
            _id: new ObjectId(strayRunId),
            turns: { $elemMatch: { id: strayTurnId, outcome: null } },
          },
          { $set: { "turns.$.outcome": "failed" } },
        );
        ({ runId } = await dispatchRun(ticketId, "execute"));
        await waitForRun(runId, "awaiting_input");
        await waitForResolvedTurns(runId);
      } finally {
        spy.mockRestore();
      }

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toEqual({
        status: "awaiting_input",
        dispatchOutcome: "needs_input",
        ticketStatus: "needs_input",
      });
    }, 20_000);

    it("keeps a healthy `continued` outcome when the monitor re-enters the finish path", async () => {
      const { runId } = await parkRun(37);
      delete process.env.T4D_OUTCOME;

      const originalUpdateOne = Collection.prototype.updateOne;
      let armed = true;
      const spy = vi.spyOn(Collection.prototype, "updateOne").mockImplementation(
        async function (this: Collection, filter, update, options) {
          const set = (update as { $set?: Record<string, unknown> }).$set;
          if (
            armed &&
            this.collectionName === "tickets" &&
            (filter as Record<string, unknown>)?.activeRunId === runId &&
            set?.status === "needs_input"
          ) {
            armed = false;
            // The re-park's run write has already landed: status awaiting_input,
            // lease released, turn stamped `continued`. Throwing HERE is what
            // sends monitorContinue's catch back into finishContinueTurn, which
            // reads exit -1 and would overwrite the healthy outcome with
            // `failed` without the write-once term.
            throw new Error("injected ticket re-park failure");
          }
          return originalUpdateOne.call(this, filter, update, options);
        },
      );

      try {
        await continueExecution(runId, "keep going");
        await waitForContinueTurn(runId, 1);
        // Give the second pass a bounded window to corrupt the outcome, then
        // assert it never did.
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          const current = await runs.findOne({ _id: new ObjectId(runId) });
          const turn = current?.turns.find((t) => t.kind === "continue");
          if (turn?.outcome === "failed") break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        spy.mockRestore();
      }

      const run = await runs.findOne({ _id: new ObjectId(runId) });
      expect(run?.turns.find((t) => t.kind === "continue")?.outcome).toBe(
        "continued",
      );
    }, 20_000);

    it("terminalizes a run whose continued re-park lost its CAS while still running", async () => {
      const { runId, ticketId } = await parkRun(38);
      delete process.env.T4D_OUTCOME;

      const pause = pauseNextTurnResolution(runId);
      const continuePromise = continueExecution(runId, "keep going");
      await pause.reached;
      try {
        // A concurrent park slips an open row in, so the re-park's CAS misses
        // while the run is STILL `running` and the lease is still ours. Every
        // entry point gates on `awaiting_input`, so releasing the lease alone
        // leaves the run unreachable until a process restart.
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
          if (current?.status === "failed") break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        pause.release();
        pause.spy.mockRestore();
      }

      const run = await runs.findOne({ _id: new ObjectId(runId) });
      expect(run?.status).toBe("failed");
      expect(run?.failureKind).toBe("runner_exit");
      expect(run?.finishedAt).not.toBeNull();
      expect(run?.executionLeaseId).toBeNull();
      // The persisted turn must describe the run it produced. `continued` here
      // would be a history that claims the turn carried on.
      expect(run?.turns.find((t) => t.kind === "continue")?.outcome).toBe(
        "failed",
      );
      // A ticket still naming a dead run can never be dispatched again...
      const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
      expect(ticket?.activeRunId).toBeNull();
      // ...and a ticket left `running` has no outgoing edge at all: no gate, no
      // public event, and dispatchRun needs `approved`. `blocked` is the status
      // the operator was just notified about, and it has a resume gate.
      expect(ticket?.status).toBe("blocked");
    }, 20_000);

    it("never fails a run a newer turn has claimed when its re-park misses", async () => {
      const { runId, ticketId } = await parkRun(40);
      delete process.env.T4D_OUTCOME;

      const originalUpdateOne = Collection.prototype.updateOne;
      let sabotaged = false;
      let claimed = false;
      const spy = vi.spyOn(Collection.prototype, "updateOne").mockImplementation(
        async function (this: Collection, filter, update, options) {
          const set = (update as { $set?: Record<string, unknown> }).$set;
          const isThisRun =
            this.collectionName === "runs" &&
            String((filter as Record<string, unknown>)?._id) === runId;
          if (!sabotaged && isThisRun && set?.status === "awaiting_input") {
            // Slip an open exchange row in just before the re-park lands, so its
            // CAS misses while the run is still `running` under this turn's lease.
            sabotaged = true;
            // Re-entering the mock is harmless: this write matches neither arm.
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
          }
          const result = await originalUpdateOne.call(
            this,
            filter,
            update,
            options,
          );
          // A write that frees this run's lease WITHOUT terminalizing it is the
          // unfenced ordering's tell: the run is `running`, its lease is free,
          // and a real continueExecution can claim it right here. Simulate that
          // claim — turn N+1 now owns the run, and nothing turn N does afterwards
          // may touch it.
          if (
            !claimed &&
            isThisRun &&
            set?.executionLeaseId === null &&
            !("status" in (set ?? {}))
          ) {
            claimed = true;
            await runs.updateOne(
              { _id: new ObjectId(runId), executionLeaseId: null },
              {
                $set: {
                  status: "running",
                  executionLeaseId: "turn-n-plus-1",
                  executionLeaseExpiresAt: new Date(
                    Date.now() + 60_000,
                  ).toISOString(),
                },
              },
            );
          }
          return result;
        },
      );

      try {
        await continueExecution(runId, "keep going");
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const current = await runs.findOne({ _id: new ObjectId(runId) });
          if (current?.status === "failed") break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        spy.mockRestore();
      }

      const run = await runs.findOne({ _id: new ObjectId(runId) });
      // The terminalize is fenced on this turn's lease and clears it in the same
      // update, so no claim can interleave: a lease still reading
      // `turn-n-plus-1` means turn N failed a run a live turn owned.
      expect(run?.executionLeaseId).toBeNull();
      expect(run?.status).toBe("failed");
      const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
      expect(ticket?.status).toBe("blocked");
    }, 20_000);

    it("pauses a continue turn on a state-mutating write, not on the trailing outcome backstop", async () => {
      const ticketId = await insertApproved(41);
      const turnId = new ObjectId().toString();
      const runId = await seedRunDoc(ticketId, {
        executionLeaseId: "lease-under-test",
        turns: [
          {
            v: 1 as const,
            id: turnId,
            index: 0,
            at: timestamp(),
            kind: "dispatch" as const,
            outcome: null,
            stdoutFile: `${repo}/.tosin4dev/turns/${turnId}/stdout.log`,
            stderrFile: `${repo}/.tosin4dev/turns/${turnId}/stderr.log`,
          },
        ],
      });

      const pause = pauseNextTurnResolution(runId);
      // Never awaited: if the helper wrongly matches this shape it blocks inside
      // the spy until release, and awaiting it would hang the test instead of
      // failing an assertion.
      let backstop: Promise<unknown> | undefined;
      let folded: Promise<unknown> | undefined;
      try {
        // finishRun's trailing backstop: the bare positional outcome write, a
        // no-op once the folded stamp landed. parkRun returns BEFORE it, so every
        // test installing this spy races it. Pausing here freezes the previous
        // turn and the sabotage lands before the continue turn has spawned.
        backstop = runs.updateOne(
          {
            _id: new ObjectId(runId),
            turns: { $elemMatch: { id: turnId, outcome: null } },
          },
          { $set: { "turns.$.outcome": "needs_input" } },
        );
        const raced = await Promise.race([
          pause.reached.then(() => "paused"),
          new Promise((resolve) => setTimeout(() => resolve("idle"), 250)),
        ]);
        expect(raced).toBe("idle");

        // The re-park's shape — lease released, outcome folded in. THIS is what
        // the helper must freeze.
        folded = runs.updateOne(
          { _id: new ObjectId(runId) },
          {
            $set: {
              status: "awaiting_input",
              executionLeaseId: null,
              "turns.$[t].outcome": "continued",
            },
          },
          { arrayFilters: [{ "t.id": turnId }] } as never,
        );
        await pause.reached;
      } finally {
        pause.release();
        await Promise.allSettled([backstop, folded]);
        pause.spy.mockRestore();
      }
    }, 20_000);

    it("does not re-run a finished dispatch turn when the monitor's catch fires", async () => {
      process.env.T4D_OUTCOME = JSON.stringify({
        outcome: "needs_input",
        question: "Guarded?",
      });
      const ticketId = await insertApproved(39);

      const originalUpdateOne = Collection.prototype.updateOne;
      let armed = true;
      let firedOn: string | null = null;
      const spy = vi.spyOn(Collection.prototype, "updateOne").mockImplementation(
        async function (this: Collection, filter, update, options) {
          const set = (update as { $set?: Record<string, unknown> }).$set;
          if (
            armed &&
            this.collectionName === "runs" &&
            set &&
            "turns.$.outcome" in set
          ) {
            armed = false;
            firedOn = String((filter as { _id?: unknown })._id);
            // The park has fully landed and already carries this turn's outcome.
            // Throwing here drives monitorChild into its catch, which re-invokes
            // finishRun with a synthetic exit -1.
            throw new Error("injected outcome-write failure");
          }
          return originalUpdateOne.call(this, filter, update, options);
        },
      );

      let runId: string;
      try {
        ({ runId } = await dispatchRun(ticketId, "execute"));
        await waitForRun(runId, "awaiting_input");
        // Give an unguarded second pass a bounded window to clear the pointer.
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          const current = await tickets.findOne({ _id: new ObjectId(ticketId) });
          if (current?.activeRunId === null) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        spy.mockRestore();
      }

      const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
      // needs_input with a null activeRunId has no legal way out: provide_input
      // has no run to resume and dispatchRun refuses the ticket's status.
      expect(ticket?.status).toBe("needs_input");
      expect(ticket?.activeRunId).toBe(runId!);
      const run = await runs.findOne({ _id: new ObjectId(runId!) });
      expect(run?.status).toBe("awaiting_input");
      expect(run?.turns.find((t) => t.kind === "dispatch")?.outcome).toBe(
        "needs_input",
      );
      // The spy disarms on the first matching write from ANY run, so a stray
      // write from an earlier test's in-flight monitor can consume it. Without this,
      // the injection never fires and every assertion below describes the healthy
      // state — the test can pass without exercising anything.
      expect(firedOn).toBe(runId!);
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
