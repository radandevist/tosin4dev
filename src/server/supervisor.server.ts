import {
  execFile,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import type { PushOperator } from "mongodb";
import {
  BoardSchema,
  ObjectIdString,
  RunPhase,
  TicketSchema,
  type Board,
  type Run,
  type Ticket,
} from "../domain/schemas";
import { transition } from "../domain/stateMachine";
import { buildPrompt } from "../runners/brief";
import { claudeAdapter } from "../runners/claude";
import { codexAdapter } from "../runners/codex";
import type { RunnerAdapter, RunnerBrief } from "../runners/types";
import { db, ObjectId } from "./db";
import { notify } from "./notify.server";
import { ServerResultError } from "./result";

type TicketDoc = Ticket & { createdAt: string; updatedAt: string };
type BoardDoc = Board & { createdAt: string; updatedAt: string };
type RunDoc = Run & {
  pid: number | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

type Phase = Run["phase"];
type TicketStatus = Ticket["status"];

interface PhasePolicy {
  requiredStatus: TicketStatus;
  claimedStatus: TicketStatus;
}

interface RunningChild {
  stdout: Promise<string>;
  stderr: Promise<string>;
  exited: Promise<number>;
}

const ACTIVITY_CAP = 50;
const SUMMARY_OUTPUT_CAP = 512_000;
const execFileAsync = promisify(execFile);
const adapters: Record<Ticket["runner"], RunnerAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

const now = () => new Date().toISOString();

function pushActivity(
  kind: string,
  message: string,
  at: string,
): PushOperator<TicketDoc> {
  return {
    activity: {
      $each: [{ at, kind, message }],
      $slice: -ACTIVITY_CAP,
    },
  };
}

function phasePolicy(ticket: Ticket, phase: Phase): PhasePolicy {
  if (phase === "spec_draft") {
    if (ticket.status !== "inbox") {
      throw new ServerResultError(
        "conflict",
        "spec drafting requires an inbox ticket",
      );
    }
    return { requiredStatus: "inbox", claimedStatus: "inbox" };
  }

  if (phase === "review_fix") {
    if (ticket.status !== "running") {
      throw new ServerResultError(
        "conflict",
        "review fixes require a running ticket after requested changes",
      );
    }
    return { requiredStatus: "running", claimedStatus: "running" };
  }

  if (ticket.status !== "approved" || ticket.spec.approvedAt === null) {
    throw new ServerResultError(
      "conflict",
      "execution requires an approved ticket and approved spec",
    );
  }
  return {
    requiredStatus: "approved",
    claimedStatus: transition("approved", "dispatch"),
  };
}

function runPaths(board: Board, runId: string, phase: Phase) {
  const root = `${board.repoPath}/.tosin4dev`;
  const runDir = `${root}/runs/${runId}`;
  return {
    runDir,
    workDir:
      phase === "spec_draft"
        ? board.repoPath
        : `${root}/worktrees/${runId}`,
    promptFile: `${runDir}/prompt.md`,
    logFile: `${runDir}/output.log`,
  };
}

export function runBranchName(runId: string): string {
  return `tosin4dev/run/${runId}`;
}

// Create the execution worktree on a fresh named branch off `baseBranch`, and
// return the branch name plus the base commit sha the branch started from. The
// named branch (unlike v1's --detach) gives verification a reachable ref.
export async function createRunBranch(
  repoPath: string,
  workDir: string,
  baseBranch: string,
  runId: string,
): Promise<{ branch: string; baseSha: string }> {
  const branch = runBranchName(runId);
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repoPath, "rev-parse", baseBranch],
    { encoding: "utf8" },
  );
  const baseSha = stdout.trim();
  try {
    await execFileAsync(
      "git",
      ["-C", repoPath, "worktree", "add", "-b", branch, workDir, baseBranch],
      { encoding: "utf8" },
    );
  } catch (error) {
    throw new Error(
      `git worktree add failed: ${error instanceof Error ? error.message : "unknown error"}`,
      { cause: error },
    );
  }
  return { branch, baseSha };
}

async function removeUnusedWorktree(
  repoPath: string,
  workDir: string,
  branch: string | null,
): Promise<void> {
  await execFileAsync(
    "git",
    ["-C", repoPath, "worktree", "remove", "--force", workDir],
    { encoding: "utf8" },
  ).catch(() => undefined);
  if (branch) {
    await execFileAsync(
      "git",
      ["-C", repoPath, "branch", "-D", branch],
      { encoding: "utf8" },
    ).catch(() => undefined);
  }
}

async function recordSetupFailure(
  runId: string,
  ticketId: string,
  originalStatus: TicketStatus,
): Promise<void> {
  const database = await db();
  const at = now();
  await database.collection<RunDoc>("runs").updateOne(
    { _id: new ObjectId(runId), status: { $in: ["queued", "running"] } },
    {
      $set: {
        status: "failed",
        exitCode: null,
        summary: "Run setup failed",
        finishedAt: at,
      },
    },
  );
  await database.collection<TicketDoc>("tickets").updateOne(
    { _id: new ObjectId(ticketId), activeRunId: runId },
    {
      $set: { activeRunId: null, status: originalStatus, updatedAt: at },
      $push: pushActivity("run", "run setup failed", at),
    },
  );
}

async function drainStream(
  stream: Readable,
  logFile: string,
  collect: boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let collected = "";
  for await (const chunk of stream) {
    await appendFile(logFile, chunk);
    if (collect) {
      collected += decoder.decode(chunk, { stream: true });
      if (collected.length > SUMMARY_OUTPUT_CAP) {
        collected = collected.slice(-SUMMARY_OUTPUT_CAP);
      }
    }
  }
  if (collect) collected += decoder.decode();
  return collected;
}

function settledExit(child: ChildProcess): Promise<number> {
  const exited = new Promise<number>((resolve, reject) => {
    let settled = false;
    const settle = (result: { code: number } | { error: Error }) => {
      if (settled) return;
      settled = true;
      child.off("error", onError);
      child.off("exit", onExit);
      if ("error" in result) reject(result.error);
      else resolve(result.code);
    };
    const onError = (error: Error) => settle({ error });
    const onExit = (code: number | null) => settle({ code: code ?? -1 });
    child.once("error", onError);
    child.once("exit", onExit);
  });
  void exited.catch(() => undefined);
  return exited;
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export function parseSummary(output: string): string | null {
  const normalized = output.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  let header = -1;
  for (let index = 0; index < lines.length; index++) {
    if (/^(?:##\s*)?SUMMARY\s*$/i.test(lines[index])) header = index;
  }
  if (header < 0) return null;
  const summary = lines
    .slice(header + 1)
    .join("\n")
    .trim()
    .split("\n")
    .slice(0, 10)
    .join("\n")
    .trim();
  return summary || null;
}

async function finishRun(
  runId: string,
  ticketId: string,
  phase: Phase,
  exitCode: number,
  stdout: string,
  logFile: string,
): Promise<void> {
  const database = await db();
  const at = now();
  const succeeded = exitCode === 0;
  const summary = parseSummary(stdout);
  await database.collection<RunDoc>("runs").updateOne(
    { _id: new ObjectId(runId), status: { $in: ["queued", "running"] } },
    {
      $set: {
        status: succeeded ? "succeeded" : "failed",
        exitCode,
        summary,
        finishedAt: at,
      },
    },
  );

  const ticketCollection = database.collection<TicketDoc>("tickets");
  if (phase === "spec_draft") {
    const ticketUpdate = await ticketCollection.updateOne(
      { _id: new ObjectId(ticketId), activeRunId: runId, status: "inbox" },
      {
        $set: { activeRunId: null, updatedAt: at },
        $push: pushActivity(
          "run",
          `spec draft ${succeeded ? "succeeded" : `failed (exit ${exitCode})`}`,
          at,
        ),
      },
    );
    if (ticketUpdate.matchedCount === 0) {
      await ticketCollection.updateOne(
        { _id: new ObjectId(ticketId), activeRunId: runId },
        { $set: { activeRunId: null, updatedAt: at } },
      );
    }
    return;
  }

  const outcome = succeeded ? "run_succeeded" : "run_failed";
  const nextStatus = transition("running", outcome);
  const ticketUpdate = await ticketCollection.updateOne(
    { _id: new ObjectId(ticketId), activeRunId: runId, status: "running" },
    {
      $set: { activeRunId: null, status: nextStatus, updatedAt: at },
      $push: pushActivity(
        "run",
        `run ${succeeded ? "succeeded" : `failed (exit ${exitCode})`}`,
        at,
      ),
    },
  );
  if (ticketUpdate.matchedCount === 0) {
    await ticketCollection.updateOne(
      { _id: new ObjectId(ticketId), activeRunId: runId },
      { $set: { activeRunId: null, updatedAt: at } },
    );
    return;
  }

  const ticketDoc = await ticketCollection.findOne({
    _id: new ObjectId(ticketId),
  });
  const boardDoc = ticketDoc
    ? await database.collection<BoardDoc>("boards").findOne({
        _id: new ObjectId(ticketDoc.boardId),
      })
    : null;
  const label = `${boardDoc?.slug ?? "?"} #${ticketDoc?.seq ?? "?"} ${ticketDoc?.title ?? "ticket"}`;
  if (nextStatus === "review_ready") {
    await notify(`✅ review-ready: ${label}\n${summary ?? ""}`);
  } else {
    await notify(
      `⛔ blocked: ${label} — run failed (exit ${exitCode}). Log: ${logFile}`,
    );
  }
}

async function monitorChild(
  child: RunningChild,
  runId: string,
  ticketId: string,
  phase: Phase,
  logFile: string,
): Promise<void> {
  try {
    const [stdout, , exitCode] = await Promise.all([
      child.stdout,
      child.stderr,
      child.exited,
    ]);
    await finishRun(runId, ticketId, phase, exitCode, stdout, logFile);
  } catch (error) {
    await appendFile(
      logFile,
      `\nSupervisor stream failure: ${error instanceof Error ? error.message : "unknown error"}\n`,
    ).catch(() => undefined);
    await finishRun(runId, ticketId, phase, -1, "", logFile);
  }
}

export async function dispatchRun(
  rawTicketId: string,
  rawPhase: Phase,
): Promise<{ runId: string }> {
  const ticketId = ObjectIdString.parse(rawTicketId);
  const phase = RunPhase.parse(rawPhase);
  const database = await db();
  const ticketCollection = database.collection<TicketDoc>("tickets");
  const rawTicket = await ticketCollection.findOne({
    _id: new ObjectId(ticketId),
  });
  if (!rawTicket) {
    throw new ServerResultError("not_found", `ticket not found: ${ticketId}`);
  }
  const ticket = TicketSchema.parse(rawTicket);
  if (ticket.activeRunId !== null) {
    throw new ServerResultError(
      "conflict",
      "ticket already has an active run",
    );
  }
  const policy = phasePolicy(ticket, phase);

  const rawBoard = await database.collection<BoardDoc>("boards").findOne({
    _id: new ObjectId(ticket.boardId),
  });
  if (!rawBoard) {
    throw new ServerResultError("not_found", `board not found: ${ticket.boardId}`);
  }
  const board = BoardSchema.parse(rawBoard);
  const runId = new ObjectId().toString();
  const paths = runPaths(board, runId, phase);
  const claimAt = now();
  const claim = await ticketCollection.updateOne(
    {
      _id: rawTicket._id,
      activeRunId: { $type: 10 },
      status: policy.requiredStatus,
    },
    {
      $set: {
        activeRunId: runId,
        status: policy.claimedStatus,
        updatedAt: claimAt,
      },
      $push: pushActivity("run", `${phase} run claimed`, claimAt),
    },
  );
  if (claim.matchedCount === 0) {
    throw new ServerResultError(
      "conflict",
      "ticket already has an active run or changed status",
    );
  }

  const run: RunDoc = {
    ticketId,
    boardId: ticket.boardId,
    runner: ticket.runner,
    phase,
    status: "queued",
    workDir: paths.workDir,
    promptFile: paths.promptFile,
    logFile: paths.logFile,
    pid: null,
    exitCode: null,
    summary: null,
    branch: null,
    baseSha: null,
    verdict: null,
    failureKind: null,
    queuedAt: claimAt,
    startedAt: null,
    finishedAt: null,
  };

  try {
    await database.collection<RunDoc>("runs").insertOne({
      _id: new ObjectId(runId),
      ...run,
    });
  } catch (error) {
    await recordSetupFailure(runId, ticketId, policy.requiredStatus);
    throw error;
  }

  let worktreeCreated = false;
  let runBranch: string | null = null;
  let child: ChildProcess | undefined;
  let runningChild: RunningChild | undefined;
  try {
    await mkdir(paths.runDir, { recursive: true });
    if (phase !== "spec_draft") {
      await mkdir(`${board.repoPath}/.tosin4dev/worktrees`, { recursive: true });
      const created = await createRunBranch(
        board.repoPath,
        paths.workDir,
        board.defaultBaseBranch,
        runId,
      );
      runBranch = created.branch;
      await database.collection<RunDoc>("runs").updateOne(
        { _id: new ObjectId(runId) },
        { $set: { branch: created.branch, baseSha: created.baseSha } },
      );
      worktreeCreated = true;
    }

    const brief: RunnerBrief = {
      ticket,
      board,
      workDir: paths.workDir,
      phase,
    };
    await writeFile(paths.promptFile, buildPrompt(brief));
    await writeFile(paths.logFile, "");
    const command = adapters[ticket.runner].buildCommand(
      brief,
      paths.promptFile,
    );
    const spawnedChild = spawn(command.cmd[0], command.cmd.slice(1), {
      cwd: paths.workDir,
      env: { ...process.env, ...command.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawnedChild;
    runningChild = {
      stdout: drainStream(spawnedChild.stdout, paths.logFile, true),
      stderr: drainStream(spawnedChild.stderr, paths.logFile, false),
      exited: settledExit(spawnedChild),
    };
    void Promise.all([
      runningChild.stdout,
      runningChild.stderr,
      runningChild.exited,
    ]).catch(() => undefined);
    await waitForSpawn(spawnedChild);
    const startedAt = now();
    await database.collection<RunDoc>("runs").updateOne(
      { _id: new ObjectId(runId), status: "queued" },
      { $set: { status: "running", pid: spawnedChild.pid, startedAt } },
    );
    void monitorChild(
      runningChild,
      runId,
      ticketId,
      phase,
      paths.logFile,
    ).catch((error) =>
      console.error(`Supervisor monitor failed for run ${runId}:`, error),
    );
    return { runId };
  } catch (error) {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await runningChild?.exited.catch(() => undefined);
    }
    if (worktreeCreated) {
      await removeUnusedWorktree(board.repoPath, paths.workDir, runBranch);
    }
    await recordSetupFailure(runId, ticketId, policy.requiredStatus);
    throw new ServerResultError("spawn_failed", "run could not be started");
  }
}

export function isProcessAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function recoverOrphans(): Promise<void> {
  const database = await db();
  const runCollection = database.collection<RunDoc>("runs");
  const staleRuns = await runCollection
    .find({ status: { $in: ["queued", "running"] } })
    .toArray();

  for (const run of staleRuns) {
    if (isProcessAlive(run.pid)) continue;
    const at = now();
    const failed = await runCollection.updateOne(
      { _id: run._id, status: { $in: ["queued", "running"] } },
      {
        $set: {
          status: "failed",
          exitCode: null,
          summary: "Run orphaned after supervisor restart",
          finishedAt: at,
        },
      },
    );
    if (failed.matchedCount === 0) continue;

    const ticketCollection = database.collection<TicketDoc>("tickets");
    if (run.phase === "spec_draft") {
      await ticketCollection.updateOne(
        { _id: new ObjectId(run.ticketId), activeRunId: run._id.toString() },
        {
          $set: { activeRunId: null, updatedAt: at },
          $push: pushActivity("run", "orphaned spec draft failed", at),
        },
      );
      continue;
    }

    const blocked = await ticketCollection.updateOne(
      {
        _id: new ObjectId(run.ticketId),
        activeRunId: run._id.toString(),
        status: "running",
      },
      {
        $set: { activeRunId: null, status: "blocked", updatedAt: at },
        $push: pushActivity("run", "orphaned run failed", at),
      },
    );
    if (blocked.matchedCount === 0) {
      await ticketCollection.updateOne(
        { _id: new ObjectId(run.ticketId), activeRunId: run._id.toString() },
        { $set: { activeRunId: null, updatedAt: at } },
      );
    }
  }
}
