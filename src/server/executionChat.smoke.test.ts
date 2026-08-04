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
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;
process.env.DISCORD_WEBHOOK_URL = "";

const { db, closeDb, ObjectId } = await import("./db");
const { continueExecution, dispatchRun, recoverOrphans } = await import(
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
async function writeRunner(): Promise<void> {
  const executable = join(binDirectory, "claude");
  await writeFile(
    executable,
    `#!/bin/sh
if [ -n "$T4D_ARGS_FILE" ]; then printf '%s\\n' "$@" > "$T4D_ARGS_FILE"; fi
printf '%s\\n' '{"type":"result","session_id":"s-smoke","result":"ok"}'
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
  const parked = await waitForRun(runId, "awaiting_input");
  expect(parked.executionSessionId).toBe("s-smoke");
  return { runId, ticketId, parked };
}

// Pause the first finishContinueTurn outcome write for the run. Mirror of the
// needs-input suite's pauseNextResumeClaim, but targeting the `turns.$.outcome`
// write that a stale turn would attempt.
function pauseNextTurnOutcomeWrite(runId: string): {
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
      if (
        !paused &&
        this.collectionName === "runs" &&
        id?.toString() === runId &&
        typeof set?.["turns.$.outcome"] === "string"
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
    executionSessionId: "s-smoke",
    executionLeaseId: null,
    executionLeaseExpiresAt: null,
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

    it("does not let a turn that lost its lease write its outcome", async () => {
      const { runId } = await parkRun(3);
      process.env.T4D_OUTCOME = JSON.stringify({
        outcome: "needs_input",
        question: "Lost lease?",
      });

      const pause = pauseNextTurnOutcomeWrite(runId);
      const continuePromise = continueExecution(runId, "stale write");
      await pause.reached;
      try {
        // While the monitor is frozen at its outcome write, the run's lease
        // moves underneath it — exactly the lost-lease condition.
        await runs.updateOne(
          { _id: new ObjectId(runId) },
          { $set: { executionLeaseId: "someone-else-owns-the-run" } },
        );
        pause.release();
        await continuePromise;
      } finally {
        pause.release();
        pause.spy.mockRestore();
      }

      const run = await waitForRun(runId, "awaiting_input");
      const turn = run.turns.find((t) => t.kind === "continue");
      expect(turn?.outcome).toBeNull();
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

      const run = await runs.findOne({ _id: new ObjectId(runId) });
      const turn = run?.turns.find((candidate) => candidate.kind === "continue");
      expect(turn?.outcome).toBe("completed");
      expect(run?.verdict).toBe("passed");
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
      const run = await waitForRun(runId, "succeeded");
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
});
