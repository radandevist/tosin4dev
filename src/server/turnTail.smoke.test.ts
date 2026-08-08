import { execFileSync } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Collection, Db, WithId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Board, Run, RunTurn, Ticket } from "../domain/schemas";

type BoardDoc = Board & { createdAt: string; updatedAt: string };
type TicketDoc = Ticket & { createdAt: string; updatedAt: string };
type RunDoc = Run & {
  pid: number | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

const TEST_DB = `tosin4dev-test-turn-tail-${process.pid}-${Date.now()}`;
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const ORIGINAL_OUTCOME = process.env.T4D_OUTCOME;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;
process.env.DISCORD_WEBHOOK_URL = "";

const { db, closeDb, ObjectId } = await import("./db");
const { turnTailCore } = await import("./runs.server");
const { dispatchRun } = await import("./supervisor.server");
const { boundary } = await import("./result");
const { TurnTailInputSchema } = await import("./runs");

let database: Db;
let boards: Collection<BoardDoc>;
let tickets: Collection<TicketDoc>;
let runs: Collection<RunDoc>;
let repo: string;
let binDirectory: string;
let boardId: string;

const timestamp = () => new Date().toISOString();

// The runner prints turn-specific stdout/stderr and, on the resume invocation
// (which the claude adapter flags with --resume), a completed outcome instead
// of parking again.
async function writeRunner(): Promise<void> {
  const executable = join(binDirectory, "claude");
  await writeFile(
    executable,
    `#!/bin/sh
if printf '%s ' "$@" | grep -q -- '--resume'; then
  printf '%s\\n' '{"type":"result","session_id":"s-resume","result":"ok"}'
  printf '%s\\n' 'resume-turn-content'
  printf '%s\\n' 'resume-turn-stderr' >&2
else
  printf '%s\\n' '{"type":"result","session_id":"s-dispatch","result":"ok"}'
  printf '%s\\n' 'dispatch-turn-content'
  printf '%s\\n' 'dispatch-turn-stderr' >&2
fi
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
    title: `turn tail ${seq}`,
    type: "implement",
    status: "approved",
    runner: "claude",
    spec: {
      intent: "exercise per-turn logs",
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

// The core fn takes the boundary-parsed shape, so this pins the schema defaults
// callers get on the wire: stdout stream, 20KB budget.
function tail(args: {
  runId: string;
  turnId: string;
  cursor: number;
}): Promise<{ chunk: string; nextCursor: number; eof: boolean }> {
  return turnTailCore({ ...args, stream: "stdout", maxBytes: 20_000 });
}

// Insert a run whose single dispatch turn points at files we control, so the
// cursor tests exercise turnTailCore directly without spawning processes.
// `extraTurns` appends later turns (kind "resume") after turn 0, for tests that
// need an earlier, already-finished turn while a later turn keeps the run
// running. Returns every turn's id alongside turn 0's.
async function insertTurnRun(params: {
  stdout: string;
  stderr?: string;
  status?: Run["status"];
  outcome?: RunTurn["outcome"];
  extraTurns?: Array<{ stdout: string; outcome?: RunTurn["outcome"] }>;
}): Promise<{
  runId: string;
  turnId: string;
  stdoutFile: string;
  turnIds: string[];
}> {
  const runId = new ObjectId().toString();
  const turnId = new ObjectId().toString();
  const runDir = join(repo, ".tosin4dev", "runs", runId);
  const turnDir = join(runDir, "turns", turnId);
  await mkdir(turnDir, { recursive: true });
  const stdoutFile = join(turnDir, "stdout.log");
  const stderrFile = join(turnDir, "stderr.log");
  await Promise.all([
    writeFile(stdoutFile, params.stdout),
    writeFile(stderrFile, params.stderr ?? ""),
  ]);
  const at = timestamp();
  const turn: RunTurn = {
    v: 1,
    id: turnId,
    index: 0,
    at,
    kind: "dispatch",
    outcome: params.outcome ?? null,
    stdoutFile,
    stderrFile,
  };
  const extra: RunTurn[] = [];
  for (const [index, spec] of (params.extraTurns ?? []).entries()) {
    const extraTurnId = new ObjectId().toString();
    const extraDir = join(runDir, "turns", extraTurnId);
    const extraStdout = join(extraDir, "stdout.log");
    const extraStderr = join(extraDir, "stderr.log");
    await mkdir(extraDir, { recursive: true });
    await Promise.all([writeFile(extraStdout, spec.stdout), writeFile(extraStderr, "")]);
    extra.push({
      v: 1,
      id: extraTurnId,
      index: index + 1,
      at,
      kind: "resume",
      outcome: spec.outcome ?? null,
      stdoutFile: extraStdout,
      stderrFile: extraStderr,
    });
  }
  const turns = [turn, ...extra];
  await runs.insertOne({
    _id: new ObjectId(runId),
    ticketId: new ObjectId().toString(),
    boardId,
    runner: "claude",
    phase: "execute",
    status: params.status ?? "running",
    workDir: repo,
    promptFile: join(runDir, "prompt.md"),
    logFile: join(runDir, "output.log"),
    stderrFile: join(runDir, "stderr.log"),
    pid: 999,
    exitCode: null,
    summary: null,
    branch: null,
    baseSha: null,
    verdict: null,
    failureKind: null,
    fixAttempts: 0,
    lastFixSignature: null,
    executionSessionId: null,
    executionLeaseId: null,
    executionLeaseExpiresAt: null,
    parkedBy: "question",
    awaitingQuestion: null,
    exchanges: [],
    turns,
    queuedAt: at,
    startedAt: at,
    finishedAt: null,
  });
  return {
    runId,
    turnId,
    stdoutFile,
    turnIds: turns.map((t) => t.id),
  };
}

describe("per-turn logs and cursor polling", () => {
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "t4d-turn-tail-repo-"));
    binDirectory = await mkdtemp(join(tmpdir(), "t4d-turn-tail-bin-"));
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
      slug: `turn-tail-${process.pid}-${Date.now()}`,
      name: "Turn Tail",
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
    await Promise.all([
      rm(repo, { recursive: true, force: true }),
      rm(binDirectory, { recursive: true, force: true }),
    ]);
  });

  it("writes two turns to separate files without bleeding into each other", async () => {
    const ticketId = await insertApproved(1);
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Which auth library?",
    });
    const { runId } = await dispatchRun(ticketId, "execute");
    await waitForRun(runId, "awaiting_input");

    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "completed",
      summary: "done",
    });
    const { provideInputCore } = await import("./tickets.server");
    await provideInputCore({ ticketId, answer: "use lucia" });

    const finishedRun = await waitForRun(runId, "succeeded");
    expect(finishedRun.turns).toHaveLength(2);
    const [turn0, turn1] = finishedRun.turns;
    expect(turn0).toMatchObject({ kind: "dispatch", index: 0 });
    expect(turn1).toMatchObject({ kind: "resume", index: 1 });
    expect(turn0.id).not.toBe(turn1.id);

    const [t0Out, t1Out, t0Err, t1Err] = await Promise.all([
      readFile(turn0.stdoutFile, "utf8"),
      readFile(turn1.stdoutFile, "utf8"),
      readFile(turn0.stderrFile, "utf8"),
      readFile(turn1.stderrFile, "utf8"),
    ]);
    expect(t0Out).toContain("dispatch-turn-content");
    expect(t0Out).not.toContain("resume-turn-content");
    expect(t1Out).toContain("resume-turn-content");
    expect(t1Out).not.toContain("dispatch-turn-content");
    expect(t0Err).toContain("dispatch-turn-stderr");
    expect(t0Err).not.toContain("resume-turn-stderr");
    expect(t1Err).toContain("resume-turn-stderr");
    expect(t1Err).not.toContain("dispatch-turn-stderr");
  }, 20_000);

  it("still writes every byte of both turns to the run-level logFile", async () => {
    const ticketId = await insertApproved(2);
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Which base branch?",
    });
    const { runId } = await dispatchRun(ticketId, "execute");
    await waitForRun(runId, "awaiting_input");

    process.env.T4D_OUTCOME = JSON.stringify({ outcome: "completed" });
    const { provideInputCore } = await import("./tickets.server");
    await provideInputCore({ ticketId, answer: "use develop" });

    const finishedRun = await waitForRun(runId, "succeeded");
    const runLevel = await readFile(finishedRun.logFile, "utf8");
    expect(runLevel).toContain("dispatch-turn-content");
    expect(runLevel).toContain("resume-turn-content");

    const runStderr = await readFile(
      finishedRun.stderrFile ?? finishedRun.logFile,
      "utf8",
    );
    expect(runStderr).toContain("dispatch-turn-stderr");
    expect(runStderr).toContain("resume-turn-stderr");
  }, 20_000);

  it("serves completed stdout for either stream of a turn", async () => {
    const ticketId = await insertApproved(3);
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Which ORM?",
    });
    const { runId } = await dispatchRun(ticketId, "execute");
    const parked = await waitForRun(runId, "awaiting_input");
    const [turn0] = parked.turns;

    const stdoutTail = await tail({
      runId,
      turnId: turn0.id,
      cursor: 0,
    });
    expect(stdoutTail.chunk).toContain("dispatch-turn-content");
    expect(stdoutTail.eof).toBe(true);

    const stderrTail = await turnTailCore({
      runId,
      turnId: turn0.id,
      cursor: 0,
      stream: "stderr",
      maxBytes: 20_000,
    });
    expect(stderrTail.chunk).toContain("dispatch-turn-stderr");
    expect(stderrTail.eof).toBe(true);
  }, 20_000);

  it("withholds a partial trailing line until its newline arrives", async () => {
    const { runId, turnId, stdoutFile } = await insertTurnRun({
      stdout: "a\nb\nc",
      status: "running",
    });

    expect(await tail({ runId, turnId, cursor: 0 })).toEqual({
      chunk: "a\nb\n",
      nextCursor: 4,
      eof: false,
    });
    // The trailing "c" is still mid-write: withheld, cursor stays put.
    expect(await tail({ runId, turnId, cursor: 4 })).toEqual({
      chunk: "",
      nextCursor: 4,
      eof: false,
    });

    await appendFile(stdoutFile, "\n");

    expect(await tail({ runId, turnId, cursor: 4 })).toEqual({
      chunk: "c\n",
      nextCursor: 6,
      eof: false,
    });
  });

  it("returns newline-less residue once the run is finished", async () => {
    const { runId, turnId } = await insertTurnRun({
      stdout: "done",
      status: "succeeded",
    });

    expect(await tail({ runId, turnId, cursor: 0 })).toEqual({
      chunk: "done",
      nextCursor: 4,
      eof: true,
    });
  });

  it("advances nextCursor by bytes, not characters", async () => {
    const { runId, turnId } = await insertTurnRun({
      stdout: "résumé\n😀\n",
      status: "succeeded",
    });

    const first = await turnTailCore({
      runId,
      turnId,
      cursor: 0,
      maxBytes: 9,
      stream: "stdout",
    });
    expect(first.chunk).toBe("résumé\n");
    expect(first.nextCursor).toBe(9);

    const second = await turnTailCore({
      runId,
      turnId,
      cursor: first.nextCursor,
      stream: "stdout",
      maxBytes: 20_000,
    });
    expect(second.chunk).toBe("😀\n");
    expect(second.nextCursor).toBe(14);
    expect(second.eof).toBe(true);
    expect(
      Buffer.byteLength(first.chunk) + Buffer.byteLength(second.chunk),
    ).toBe(14);
  });

  it("emits a line longer than maxBytes instead of withholding it forever", async () => {
    const line = "x".repeat(200);
    const { runId, turnId } = await insertTurnRun({
      stdout: `${line}\n`,
      status: "running",
    });

    // A full read window with no '\n' is proof the line outgrows the window:
    // waiting for the newline would never see one inside this window, so the
    // whole window must be emitted and the cursor advanced past it.
    const first = await turnTailCore({
      runId,
      turnId,
      cursor: 0,
      maxBytes: 64,
      stream: "stdout",
    });
    expect(first.chunk).toBe("x".repeat(64));
    expect(first.nextCursor).toBe(64);
    expect(first.eof).toBe(false);
  });

  it("polls across a line larger than maxBytes without losing or duplicating bytes", async () => {
    const content = `${"y".repeat(1_000)}\n`;
    const { runId, turnId } = await insertTurnRun({
      stdout: content,
      status: "running",
    });

    let cursor = 0;
    let guard = 0;
    const pieces: string[] = [];
    while (guard++ < 200) {
      const result = await turnTailCore({
        runId,
        turnId,
        cursor,
        maxBytes: 64,
        stream: "stdout",
      });
      if (result.chunk) pieces.push(result.chunk);
      if (result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }

    expect(pieces.join("")).toBe(content);
    expect(cursor).toBe(Buffer.byteLength(content));
  });

  it("never emits U+FFFD when a forced flush splits a multi-byte character", async () => {
    // 63 ASCII bytes push the right-arrow's lead byte (0xE2) onto the 64-byte
    // window edge; its continuation bytes fall outside the window. The e-acute
    // characters exercise a 2-byte sequence below the split as well.
    const content = `${"a".repeat(63)}→${"é".repeat(5)}${"q".repeat(200)}\n`;
    const { runId, turnId, stdoutFile } = await insertTurnRun({
      stdout: content,
      status: "running",
    });

    let cursor = 0;
    let guard = 0;
    const pieces: string[] = [];
    while (guard++ < 200) {
      const result = await turnTailCore({
        runId,
        turnId,
        cursor,
        maxBytes: 64,
        stream: "stdout",
      });
      expect(result.chunk).not.toContain("\uFFFD");
      if (result.chunk) pieces.push(result.chunk);
      if (result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }

    expect(cursor).toBe((await readFile(stdoutFile)).length);
    expect(pieces.join("")).toBe(content);
  });

  it("restarts from the top when a cursor is beyond EOF and reports eof: false", async () => {
    const { runId, turnId, stdoutFile } = await insertTurnRun({
      stdout: "one\ntwo\n",
      status: "succeeded",
    });
    const size = (await readFile(stdoutFile)).length;

    expect(
      await turnTailCore({
        runId,
        turnId,
        cursor: size + 1_000,
        stream: "stdout",
        maxBytes: 20_000,
      }),
    ).toEqual({ chunk: "", nextCursor: 0, eof: false });

    const running = await insertTurnRun({
      stdout: "one\ntwo\n",
      status: "running",
    });
    const runningSize = (await readFile(running.stdoutFile)).length;
    expect(
      await turnTailCore({
        runId: running.runId,
        turnId: running.turnId,
        cursor: runningSize + 1_000,
        stream: "stdout",
        maxBytes: 20_000,
      }),
    ).toEqual({ chunk: "", nextCursor: 0, eof: false });
  });

  it("does not report eof on a queued run whose turn has not started", async () => {
    // dispatchRun persists turn 0 with empty files before spawning, while the
    // run is still `queued`. Reporting eof here would make a client that stops
    // polling on eof render an empty log for the entire run.
    const { runId, turnId } = await insertTurnRun({
      stdout: "",
      status: "queued",
    });

    expect(await tail({ runId, turnId, cursor: 0 })).toEqual({
      chunk: "",
      nextCursor: 0,
      eof: false,
    });
  });

  it("reports eof on an earlier turn that declared an outcome while a later turn runs", async () => {
    // Turn completion is DECLARED, never inferred from array position: every
    // terminal path writes the turn's outcome. A resolved earlier turn is eof
    // even while the run keeps producing bytes for the turn after it.
    const { runId, turnIds } = await insertTurnRun({
      stdout: "done\n",
      status: "running",
      outcome: "needs_input",
      extraTurns: [{ stdout: "later\n" }],
    });

    expect(await tail({ runId, turnId: turnIds[0], cursor: 0 })).toEqual({
      chunk: "done\n",
      nextCursor: 5,
      eof: true,
    });
    // ...and the live later turn is NOT eof.
    expect(await tail({ runId, turnId: turnIds[1], cursor: 0 })).toEqual({
      chunk: "later\n",
      nextCursor: 6,
      eof: false,
    });
  });

  it("does not call an outcome-less turn finished just because a later turn exists", async () => {
    // Position-derived completion is unsound in the other direction: resumeRun
    // and continueExecution flip the run to `running` in their claim and only
    // push the new turn row after mkdir/writeFile/spawn. During that window the
    // PREVIOUS turn is still last on a running run, so a position rule would
    // report eof true → false → true and a polling client would stop early.
    const { runId, turnIds } = await insertTurnRun({
      stdout: "done\n",
      status: "running",
      outcome: null,
      extraTurns: [{ stdout: "later\n" }],
    });

    expect(await tail({ runId, turnId: turnIds[0], cursor: 0 })).toEqual({
      chunk: "done\n",
      nextCursor: 5,
      eof: false,
    });
  });

  it("rejects a maxBytes below the 16-byte floor instead of deadlocking", async () => {
    // The reviewer's repro: file "éX\n", maxBytes 1, cursor 0 returns an empty
    // chunk with nextCursor === cursor forever, because the UTF-8 trim-back
    // reduces the whole window to nothing. The schema now floors maxBytes at 16.
    const { runId, turnId } = await insertTurnRun({
      stdout: "éX\n",
      status: "running",
    });

    const result = await boundary(
      TurnTailInputSchema,
      { runId, turnId, cursor: 0, maxBytes: 1, stream: "stdout" },
      turnTailCore,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_input");
  });

  it("re-delivers a truncated file instead of skipping it forever", async () => {
    const { runId, turnId, stdoutFile } = await insertTurnRun({
      stdout: "aaaa\nbbbb\n",
      status: "running",
    });

    expect(await tail({ runId, turnId, cursor: 0 })).toEqual({
      chunk: "aaaa\nbbbb\n",
      nextCursor: 10,
      eof: false,
    });

    // The file is replaced by something shorter: cursor 10 is beyond the new
    // size 3. Restart from the top so the replacement content is delivered,
    // instead of clamping to size and skipping it forever.
    await writeFile(stdoutFile, "cc\n");
    expect(await tail({ runId, turnId, cursor: 10 })).toEqual({
      chunk: "",
      nextCursor: 0,
      eof: false,
    });
    expect(await tail({ runId, turnId, cursor: 0 })).toEqual({
      chunk: "cc\n",
      nextCursor: 3,
      eof: false,
    });
  });

  it("returns not_found for an unknown runId or turnId", async () => {
    const { runId } = await insertTurnRun({
      stdout: "x\n",
      status: "succeeded",
    });

    await expect(
      turnTailCore({
        runId: new ObjectId().toString(),
        turnId: "any-turn",
        cursor: 0,
        stream: "stdout",
        maxBytes: 20_000,
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    await expect(
      turnTailCore({
        runId,
        turnId: "does-not-exist",
        cursor: 0,
        stream: "stdout",
        maxBytes: 20_000,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
