import {
  execFile,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import type {
  Collection,
  Db,
  Filter,
  PushOperator,
  UpdateOptions,
} from "mongodb";
import { unmetDependencies } from "../domain/dependencies";
import {
  decideFix,
  fixSignature,
  FIX_SIGNATURE_TAIL_BYTES,
  type FixDecision,
} from "../domain/fix-loop";
import {
  BoardSchema,
  EvidenceSchema,
  ObjectIdString,
  RunPhase,
  RunSchema,
  TicketSchema,
  type Board,
  type Evidence,
  type HandoffBrief,
  type PendingFixFeedback,
  type Run,
  type RunTurn,
  type Ticket,
} from "../domain/schemas";
import { transition } from "../domain/stateMachine";
import { buildPrompt } from "../runners/brief";
import { claudeAdapter } from "../runners/claude";
import { codexAdapter } from "../runners/codex";
import type { RunnerAdapter, RunnerBrief } from "../runners/types";
import { db, ObjectId } from "./db";
import { captureDraftedSpec, readDraftedSpec } from "./draftedSpec.server";
import { notify } from "./notify.server";
import { parseSessionId, readOutcome } from "./outcome.server";
import { preflightPublish, publishRun } from "./publish.server";
import { ServerResultError } from "./result";
import { verifyRun } from "./verify.server";

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
// Bounded degradation (losing the oldest rows) is deliberately preferred over
// an unreadable oversized run document that loses the entire exchange history.
const EXCHANGE_CAP = 50;
// Turns accumulate one row per dispatch/resume for the life of a run, so the
// same bounded degradation applies: keep the newest turns rather than let a
// long-lived run grow the document without limit.
const TURN_CAP = 50;
// A runner can commit while acceptance checks are still running. Re-run the
// checks a bounded number of times when that makes the evidence stale; an
// endlessly moving branch must not consume the owner's verification budget.
const MAX_STALE_REVERIFY_ATTEMPTS = 2;
// A `continue` turn holds an exclusive lease on the run for the duration of the
// spawned process. If the lease expires (supervisor down / process lost) the
// run is claimable again by a fresh turn.
const EXECUTION_LEASE_MS = 15 * 60 * 1000;
const questionOrFallback = (
  question: string | null | undefined,
  fallback: string,
) => (question?.trim() ? question : fallback);
// The collected buffer feeds parseSessionId (whose marker is the FIRST line of
// provider output) and summary extraction (which cares about the END). Keep a
// head window and a tail window rather than a tail alone.
const SUMMARY_HEAD_CAP = 64_000;
const SUMMARY_TAIL_CAP = 448_000;
const TRUNCATION_MARKER = "\n…[output truncated]…\n";
const execFileAsync = promisify(execFile);
const adapters: Record<Ticket["runner"], RunnerAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};
const globalForBoot = globalThis as typeof globalThis & {
  __tosin4devRecovered?: Promise<void>;
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

async function assertDependenciesMet(
  ticket: Ticket,
  ticketCollection: Collection<TicketDoc>,
): Promise<void> {
  if (ticket.dependsOn.length === 0) return;
  const ids = ticket.dependsOn.map((dependency) => new ObjectId(dependency));
  const docs = await ticketCollection
    .find({ _id: { $in: ids } })
    .project<{ _id: ObjectId; seq: number; status: TicketStatus }>({
      seq: 1,
      status: 1,
    })
    .toArray();
  const present = docs.map((dependency) => ({
    ticketId: dependency._id.toString(),
    seq: dependency.seq,
    status: dependency.status,
  }));
  const unmet = unmetDependencies(ticket.dependsOn, present);
  if (unmet.length > 0) {
    const label = unmet
      .map((dependency) =>
        dependency.seq !== null
          ? `#${dependency.seq} (${dependency.reason})`
          : `${dependency.ticketId} (${dependency.reason})`,
      )
      .join(", ");
    throw new ServerResultError(
      "conflict",
      `blocked: waiting on dependencies ${label}`,
    );
  }
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
    stderrFile: `${runDir}/stderr.log`,
  };
}

// Per-turn log paths under <runDir>/turns/<turnId>. Turn ids are serialized
// ObjectIds (`new ObjectId().toString()`), which are globally unique and sort
// by creation order — never Math.random or Date.now.
export function turnPaths(runDir: string, turnId: string) {
  const turnDir = `${runDir}/turns/${turnId}`;
  return {
    turnDir,
    stdoutFile: `${turnDir}/stdout.log`,
    stderrFile: `${turnDir}/stderr.log`,
  };
}

export function runBranchName(runId: string): string {
  return `tosin4dev/run/${runId}`;
}

async function readBranchTip(workDir: string): Promise<string | null> {
  try {
    return (
      await execFileAsync("git", ["-C", workDir, "rev-parse", "HEAD"], {
        encoding: "utf8",
      })
    ).stdout.trim();
  } catch {
    return null;
  }
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

// A turn's outcome is written EXACTLY once. The `outcome: null` term is what
// makes that true: monitorContinue's catch can re-enter finishContinueTurn after
// a healthy turn already resolved, and would otherwise overwrite `continued`
// with `failed`. $elemMatch rather than dotted paths — dotted conditions on an
// array match across DIFFERENT elements, so the positional `$` could bind an
// element that satisfies only one of the two terms.
async function recordTurnOutcome(
  runs: Collection<RunDoc>,
  runId: string,
  turnId: string,
  outcome: Exclude<RunTurn["outcome"], null>,
): Promise<void> {
  await runs.updateOne(
    {
      _id: new ObjectId(runId),
      turns: { $elemMatch: { id: turnId, outcome: null } },
    },
    { $set: { "turns.$.outcome": outcome } },
  );
}

// A turn's outcome must never become visible LATER than the state change it
// describes. Written as its own trailing update, the park is already public (run
// `awaiting_input`, ticket `needs_input`, operator notified) while the turn that
// produced it still reads `outcome: null` — and a continueExecution claim landing
// in that window reports `eof: false` for a turn that is over. This folds the
// outcome into the SAME updateOne as the state change, so the pair is atomic.
//
// Both array-filter terms are load-bearing. `t.id` pins THIS turn — a bare
// `t.outcome: null` would stamp every unresolved turn in the array. `t.outcome:
// null` keeps the write once-only, exactly as recordTurnOutcome's $elemMatch
// does.
//
// Precondition: the `turns` path must EXIST on the matched document. An array
// filter matching no ELEMENT is a silent no-op, but an absent `turns` field
// makes the whole updateOne throw MongoServerError 2 ("The path 'turns' must
// exist in the document in order to apply array updates") — which would reject
// the state change this stamp rides along with. Every caller satisfies it today:
// the stamp always runs after the turn's own `$push`, on a document inserted
// with `turns: []`. Do not fold a stamp into an update that can run before the
// run document has a `turns` array.
type TurnStamp = { set: Record<string, unknown>; options: UpdateOptions };

function turnStamp(
  turnId: string | null,
  outcome: Exclude<RunTurn["outcome"], null>,
): TurnStamp {
  if (turnId === null) return { set: {}, options: {} };
  return {
    set: { "turns.$[t].outcome": outcome },
    options: { arrayFilters: [{ "t.id": turnId, "t.outcome": null }] },
  };
}

async function recordSetupFailure(
  runId: string,
  ticketId: string,
  originalStatus: TicketStatus,
  turnId: string,
): Promise<void> {
  const database = await db();
  const runs = database.collection<RunDoc>("runs");
  const at = now();
  await runs.updateOne(
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
  // The dispatch turn never ran, but it is over. A turn with no outcome renders
  // as "running" forever.
  await recordTurnOutcome(runs, runId, turnId, "failed");
  await database.collection<TicketDoc>("tickets").updateOne(
    { _id: new ObjectId(ticketId), activeRunId: runId },
    {
      $set: { activeRunId: null, status: originalStatus, updatedAt: at },
      $push: pushActivity("run", "run setup failed", at),
    },
  );
}

export async function drainStream(
  stream: Readable,
  logFiles: string | string[],
  collect: boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let head = "";
  let tail = "";
  let dropped = false;
  const absorb = (text: string): void => {
    if (head.length < SUMMARY_HEAD_CAP) {
      let room = SUMMARY_HEAD_CAP - head.length;
      // Never split a surrogate pair across the head/tail boundary: in the
      // dropped case the marker would land between the halves.
      if (room > 0 && room < text.length) {
        const code = text.charCodeAt(room - 1);
        if (code >= 0xd800 && code <= 0xdbff) room -= 1;
      }
      head += text.slice(0, room);
      text = text.slice(room);
      if (!text) return;
    }
    tail += text;
    if (tail.length > SUMMARY_TAIL_CAP) {
      tail = tail.slice(-SUMMARY_TAIL_CAP);
      dropped = true;
    }
  };
  const targets = Array.isArray(logFiles) ? logFiles : [logFiles];
  for await (const chunk of stream) {
    // Fan-out: append each chunk to EVERY target. Targets are awaited
    // sequentially so bytes land in the same order within each file; a copy
    // that lags never lets a later chunk overtake an earlier one.
    for (const target of targets) {
      await appendFile(target, chunk);
    }
    if (collect) absorb(decoder.decode(chunk, { stream: true }));
  }
  if (collect) absorb(decoder.decode());
  if (!collect) return "";
  if (!tail) return head;
  // The marker is newline-delimited on BOTH sides on purpose: without the
  // leading newline it would glue onto a partial head line, without the
  // trailing one the tail's partial first line would glue onto the marker.
  // Either would manufacture a corrupt line. As written the only damage is one
  // orphan partial line, which every line-based parser here already skips.
  return dropped ? head + TRUNCATION_MARKER + tail : head + tail;
}

export function settledExit(child: ChildProcess): Promise<number> {
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

export function waitForSpawn(child: ChildProcess): Promise<void> {
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
  // drainStream may prepend a window from the START of the run so session ids
  // survive. A SUMMARY header in that head window is early scratch output, not
  // the run's final summary — taking it would report scratch as the result.
  // The truncation marker is exactly the head/tail delimiter, so search only
  // what follows it.
  const markerAt = normalized.lastIndexOf(TRUNCATION_MARKER);
  const searchable =
    markerAt < 0
      ? normalized
      : normalized.slice(markerAt + TRUNCATION_MARKER.length);
  const lines = searchable.split("\n");
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

async function ticketLabel(database: Db, ticketId: string): Promise<string> {
  const ticketDoc = await database
    .collection<TicketDoc>("tickets")
    .findOne({ _id: new ObjectId(ticketId) });
  const boardDoc = ticketDoc
    ? await database
        .collection<BoardDoc>("boards")
        .findOne({ _id: new ObjectId(ticketDoc.boardId) })
    : null;
  return `${boardDoc?.slug ?? "?"} #${ticketDoc?.seq ?? "?"} ${ticketDoc?.title ?? "ticket"}`;
}

// `prUrl` is required (not defaulted) because the `$set` writes it
// unconditionally: a default would let a future success path silently erase
// the ticket's PR link with no type error to catch it.
async function transitionTicketSucceeded(
  database: Db,
  ticketId: string,
  runId: string,
  at: string,
  prUrl: string | null,
): Promise<void> {
  const tickets = database.collection<TicketDoc>("tickets");
  const nextStatus = transition("running", "run_succeeded");
  const upd = await tickets.updateOne(
    { _id: new ObjectId(ticketId), activeRunId: runId, status: "running" },
    {
      $set: { activeRunId: null, status: nextStatus, updatedAt: at, prUrl },
      $push: pushActivity("run", "run succeeded (verified)", at),
    },
  );
  if (upd.matchedCount === 0) {
    await tickets.updateOne(
      { _id: new ObjectId(ticketId), activeRunId: runId },
      { $set: { activeRunId: null, updatedAt: at } },
    );
  }
}

// Write a completed spec_draft's structured output into its ticket and move it
// to spec_review for the owner to approve.
//
// The `status: "inbox"` filter IS the guard: inbox is the only status carrying
// a submit_spec edge, so a draft that completes after the owner has already
// moved the ticket on is refused by the state machine's own rule rather than
// clobbering work. A null return from readDraftedSpec is a no-op for the same
// reason a partial spec is refused — it would look approval-ready while
// missing the acceptance criteria the whole contract rests on.
export async function applyDraftedSpec(
  ticketId: string,
  runDir: string,
  at: string,
): Promise<void> {
  const draft = await readDraftedSpec(runDir);
  if (!draft) {
    // Visible no-op: an absent or invalid draft must not look like a successful
    // apply, so record activity naming the cause. No status/spec change — the
    // ticket stays in inbox and the whole point is that a bad draft writes
    // nothing to the spec.
    const database = await db();
    await database.collection<TicketDoc>("tickets").updateOne(
      { _id: new ObjectId(ticketId) },
      { $push: pushActivity("spec", "spec draft produced no usable spec.json", at) },
    );
    return;
  }
  const database = await db();
  await database.collection<TicketDoc>("tickets").updateOne(
    { _id: new ObjectId(ticketId), status: "inbox" },
    {
      $set: {
        status: transition("inbox", "submit_spec"),
        "spec.intent": draft.intent,
        "spec.scope": draft.scope,
        "spec.nonGoals": draft.nonGoals,
        "spec.acceptance": draft.acceptance,
        "spec.links": draft.links,
        "spec.risk": draft.risk,
        updatedAt: at,
      },
      $push: pushActivity("spec", "drafted spec applied", at),
    },
  );
}

async function transitionTicketFailed(
  database: Db,
  ticketId: string,
  runId: string,
  at: string,
  reason: string,
): Promise<void> {
  const tickets = database.collection<TicketDoc>("tickets");
  const nextStatus = transition("running", "run_failed");
  const upd = await tickets.updateOne(
    { _id: new ObjectId(ticketId), activeRunId: runId, status: "running" },
    {
      $set: { activeRunId: null, status: nextStatus, updatedAt: at },
      $push: pushActivity("run", reason, at),
    },
  );
  if (upd.matchedCount === 0) {
    await tickets.updateOne(
      { _id: new ObjectId(ticketId), activeRunId: runId },
      { $set: { activeRunId: null, updatedAt: at } },
    );
  }
}

async function notifyReviewReady(
  database: Db,
  ticketId: string,
  summary: string | null,
): Promise<void> {
  await notify(`✅ review-ready: ${await ticketLabel(database, ticketId)}\n${summary ?? ""}`);
}

async function notifyBlocked(
  database: Db,
  ticketId: string,
  reason: string,
  logFile: string,
  stderrFile: string | null,
): Promise<void> {
  await notify(`⛔ blocked: ${await ticketLabel(database, ticketId)} — ${reason}. Log: ${logFile}${stderrFile ? ` (stderr: ${stderrFile})` : ""}`);
}

export async function parkTicketNeedsInput(
  database: Db,
  runId: string,
  ticketId: string,
  question: string,
  summary: string | null,
  handoff: HandoffBrief | null,
  at: string,
  // The turn this park resolves, or null when no turn is in play (direct callers
  // in tests). Its outcome rides THIS update — see turnStamp.
  turnId: string | null,
): Promise<void> {
  const stamp = turnStamp(turnId, "needs_input");
  await database.collection<RunDoc>("runs").updateOne(
    {
      _id: new ObjectId(runId),
      status: { $in: ["queued", "running", "verifying"] },
    },
    {
      $set: {
        status: "awaiting_input",
        parkedBy: "question",
        awaitingQuestion: question,
        summary,
        ...stamp.set,
      },
      $push: {
        exchanges: {
          $each: [
            {
              v: 1 as const,
              at,
              question,
              handoff,
              answer: null,
              answeredAt: null,
            },
          ],
          $slice: -EXCHANGE_CAP,
        },
      },
    },
    stamp.options,
  );
  const tickets = database.collection<TicketDoc>("tickets");
  const nextStatus = transition("running", "run_needs_input");
  // Keep activeRunId: the run is parked and provideInput will resume it.
  await tickets.updateOne(
    {
      _id: new ObjectId(ticketId),
      activeRunId: runId,
      status: "running",
    },
    {
      $set: { status: nextStatus, updatedAt: at },
      $push: pushActivity("run", `needs input: ${question}`, at),
    },
  );
}

async function failVerifiedRun(
  database: Db,
  runId: string,
  failureKind:
    | "runner_exit"
    | "no_commit"
    | "verification_failed"
    | "runner_reported_failure",
  exitCode: number,
  summary: string | null,
  at: string,
  stamp: TurnStamp,
): Promise<void> {
  await database.collection<RunDoc>("runs").updateOne(
    { _id: new ObjectId(runId), status: { $in: ["queued", "running", "verifying"] } },
    {
      $set: {
        status: "failed",
        exitCode,
        summary,
        verdict: "failed",
        failureKind,
        finishedAt: at,
        ...stamp.set,
      },
    },
    stamp.options,
  );
}

async function parkSuppressedFeedback(
  database: Db,
  runId: string,
  ticketId: string,
  pending: PendingFixFeedback,
  turnId: string,
): Promise<void> {
  const runs = database.collection<RunDoc>("runs");
  const currentRaw = await runs.findOne({ _id: new ObjectId(runId) });
  if (!currentRaw) return;
  const current = RunSchema.parse(currentRaw);
  if (!["running", "verifying", "awaiting_input"].includes(current.status)) return;

  const at = now();
  const openExchange = current.exchanges.some((exchange) => exchange.answer === null);
  const parkedBy = current.status === "awaiting_input" ? current.parkedBy : "continued";
  const awaitingQuestion =
    current.status === "awaiting_input"
      ? current.awaitingQuestion
      : "(verification feedback pending)";
  const hasTurn = current.turns.some(
    (turn) => turn.id === turnId && turn.outcome === null,
  );
  const stamp = hasTurn ? turnStamp(turnId, "completed") : { set: {}, options: {} };
  const filter: Filter<RunDoc> = {
    _id: new ObjectId(runId),
    status: { $in: ["running", "verifying", "awaiting_input"] },
  };
  if (!openExchange) {
    filter.exchanges = { $not: { $elemMatch: { answer: null } } };
  }

  const parked = await runs.updateOne(
    filter,
    {
      $set: {
        status: "awaiting_input",
        parkedBy,
        awaitingQuestion,
        pid: null,
        executionLeaseId: null,
        executionLeaseExpiresAt: null,
        pendingFixFeedback: pending,
        ...stamp.set,
      },
      ...(openExchange
        ? {}
        : {
            $push: {
              exchanges: {
                $each: [
                  {
                    v: 1 as const,
                    at,
                    question: awaitingQuestion ?? "(verification feedback pending)",
                    handoff: null,
                    answer: null,
                    answeredAt: null,
                  },
                ],
                $slice: -EXCHANGE_CAP,
              },
            },
          }),
    },
    stamp.options,
  );
  if (parked.matchedCount === 0 && !openExchange) {
    // A concurrent park may have created the open row after our snapshot. Keep
    // the pending feedback and state, but never manufacture a second question.
    await runs.updateOne(
      {
        _id: new ObjectId(runId),
        status: { $in: ["running", "verifying", "awaiting_input"] },
      },
      {
        $set: {
          status: "awaiting_input",
          parkedBy,
          awaitingQuestion,
          pid: null,
          executionLeaseId: null,
          executionLeaseExpiresAt: null,
          pendingFixFeedback: pending,
          ...stamp.set,
        },
      },
      stamp.options,
    );
  }

  await database.collection<TicketDoc>("tickets").updateOne(
    { _id: new ObjectId(ticketId), activeRunId: runId, status: "running" },
    {
      $set: { status: "needs_input", updatedAt: at },
      $push: pushActivity("run", "verification feedback pending", at),
    },
  );
}

// Park feedback whose send was suppressed (lost lease claim, a parked run, or a
// send error). Nothing is recorded as delivered: the pending message is durable
// and the counter/signature stay unchanged until a resumed turn actually sends
// it. A run with a captured session has a safe continuation path, so it must not
// be terminalized merely because this particular send did not happen.
async function failSuppressedTail(
  database: Db,
  runId: string,
  ticketId: string,
  turnId: string,
  pending: PendingFixFeedback,
): Promise<"completed"> {
  await parkSuppressedFeedback(database, runId, ticketId, pending, turnId);
  await notify(
    `⏸️ verification feedback pending: ${await ticketLabel(database, ticketId)} — resume the execution session to deliver it`,
  );
  return "completed";
}

// Apply everything a finished process implies (run status, verification, ticket
// transitions, notifications) and RETURN what that turn produced. The non-null
// return type is the mechanism: TypeScript refuses to compile a terminal branch
// that forgets to declare an outcome, which is how `finishRun` can promise that
// every dispatch/resume/continue turn ends with one written exactly once.
//
// The returned value describes THE TURN, not the run: a turn that declared
// `completed` returns "completed" even when Tosin4dev's own verification then
// fails the run. The run's status carries that verdict.
export async function applyRunCompletion(
  runId: string,
  ticketId: string,
  phase: Phase,
  exitCode: number,
  stdout: string,
  logFile: string,
  stderrFile: string | null,
  board: Board,
  runDir: string,
  turnId: string,
): Promise<Exclude<RunTurn["outcome"], null>> {
  const database = await db();
  const at = now();
  const succeeded = exitCode === 0;
  const summary = parseSummary(stdout);
  const runs = database.collection<RunDoc>("runs");
  const tickets = database.collection<TicketDoc>("tickets");

  // spec_draft: read-only, no verification. The runner prints a bounded
  // structured spec block on stdout; Tosin-owned code writes spec.json from
  // it and a successful draft writes itself into the ticket. A failed one
  // leaves it alone.
  if (phase === "spec_draft") {
    const stamp = turnStamp(turnId, succeeded ? "completed" : "failed");
    await runs.updateOne(
      { _id: new ObjectId(runId), status: { $in: ["queued", "running"] } },
      {
        $set: {
          status: succeeded ? "succeeded" : "failed",
          exitCode,
          summary,
          finishedAt: at,
          ...stamp.set,
        },
      },
      stamp.options,
    );
    const upd = await tickets.updateOne(
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
    if (upd.matchedCount === 0) {
      await tickets.updateOne(
        { _id: new ObjectId(ticketId), activeRunId: runId },
        { $set: { activeRunId: null, updatedAt: at } },
      );
    }
    if (succeeded) {
      await captureDraftedSpec(stdout, runDir);
      await applyDraftedSpec(ticketId, runDir, at);
    }
    return succeeded ? "completed" : "failed";
  }

  // execute / review_fix — a nonzero runner exit fails fast, no verification.
  if (!succeeded) {
    const stamp = turnStamp(turnId, "failed");
    await runs.updateOne(
      { _id: new ObjectId(runId), status: { $in: ["queued", "running", "verifying"] } },
      {
        $set: {
          status: "failed",
          exitCode,
          summary,
          failureKind: "runner_exit",
          finishedAt: at,
          ...stamp.set,
        },
      },
      stamp.options,
    );
    await transitionTicketFailed(database, ticketId, runId, at, `run failed (exit ${exitCode})`);
    await notifyBlocked(
      database,
      ticketId,
      `run failed (exit ${exitCode})`,
      logFile,
      stderrFile,
    );
    return "failed";
  }

  // exit 0: capture the session id, then read the runner's declared outcome.
  const runDoc = await runs.findOne({ _id: new ObjectId(runId) });
  const sessionId = runDoc ? parseSessionId(runDoc.runner, stdout) : null;
  if (sessionId) {
    await runs.updateOne(
      { _id: new ObjectId(runId) },
      { $set: { executionSessionId: sessionId } },
    );
  }
  const outcome = await readOutcome(runDir);
  const outSummary = outcome.summary ?? summary;
  if (outcome.outcome === "needs_input") {
    const question = questionOrFallback(
      outcome.question,
      "(no question provided)",
    );
    await parkTicketNeedsInput(
      database,
      runId,
      ticketId,
      question,
      outSummary,
      outcome.handoff,
      at,
      turnId,
    );
    await notify(
      `⏸️ needs input: ${await ticketLabel(database, ticketId)} — ${outcome.question ?? ""}`,
    );
    return "needs_input";
  }
  if (outcome.outcome === "failed") {
    const failedAt = now();
    await failVerifiedRun(
      database,
      runId,
      "runner_reported_failure",
      exitCode,
      outSummary,
      failedAt,
      turnStamp(turnId, "failed"),
    );
    await transitionTicketFailed(
      database,
      ticketId,
      runId,
      failedAt,
      `runner reported failure: ${outcome.reason ?? "unspecified"}`,
    );
    await notifyBlocked(
      database,
      ticketId,
      "runner reported failure",
      logFile,
      stderrFile,
    );
    return "failed";
  }

  // outcome.outcome === "completed" falls through to the existing verification gate.
  // exit 0: Tosin4dev proves the work. Claim the `verifying` transition INSIDE the
  // try so any failure here is fail-closed. If we can't claim it, the run was
  // already terminalized (e.g. orphan recovery) — bail and touch nothing.
  const verifyAt = now();
  try {
    const claimed = await runs.updateOne(
      { _id: new ObjectId(runId), status: { $in: ["queued", "running"] } },
      { $set: { status: "verifying" } },
    );
    // Someone else already terminalized the run. Touch nothing further, but the
    // turn still declared `completed`. This is the one branch with no state
    // change to fold the outcome into — finishRun's backstop closes the row.
    if (claimed.matchedCount === 0) return "completed";
    const run = await runs.findOne({ _id: new ObjectId(runId) });
    // The claim matched, so the row existed a moment ago; if it is gone now the
    // run was deleted underneath us. Touching nothing (as the matchedCount === 0
    // path does) is the correct fail-closed reaction, and the early return
    // narrows `run` to non-null so the fix-loop tail below never needs a `!`.
    if (!run) return "completed";
    const verifyParams = {
      repoPath: board.repoPath,
      workDir: run?.workDir ?? board.repoPath,
      runDir,
      branch: run?.branch ?? "",
      baseSha: run?.baseSha ?? "",
      checks: board.checks,
      at: verifyAt,
    };
    let result = await verifyRun(verifyParams);
    const doneAt = now();
    let evidenceCreatedAt = doneAt;
    let evidence = EvidenceSchema.parse({
      runId,
      ticketId,
      commitSha: result.commitSha,
      commitRef: result.commitRef,
      checks: result.checks,
      verdict: result.verdict,
      createdAt: evidenceCreatedAt,
    });
    await database.collection("evidence").insertOne(evidence);

    // Evidence is written before this guard so every verification pass remains
    // inspectable. A runner may commit while the checks are running, making the
    // just-written row stale by the time feedback is prepared. Discard only the
    // stale feedback and verify the current tip again, with a hard bound for a
    // branch that keeps moving. If the tip cannot be read, leave the final
    // suppression decision to deliverFixFeedback, which parks the feedback
    // instead of sending evidence tied to an unknown commit.
    for (let attempt = 0; attempt < MAX_STALE_REVERIFY_ATTEMPTS; attempt++) {
      const tipNow = await readBranchTip(run.workDir);
      if (tipNow === null || tipNow === result.commitSha) break;
      result = await verifyRun(verifyParams);
      evidenceCreatedAt = new Date(
        Math.max(Date.parse(evidenceCreatedAt) + 1, Date.now()),
      ).toISOString();
      evidence = EvidenceSchema.parse({
        runId,
        ticketId,
        commitSha: result.commitSha,
        commitRef: result.commitRef,
        checks: result.checks,
        verdict: result.verdict,
        createdAt: evidenceCreatedAt,
      });
      await database.collection("evidence").insertOne(evidence);
    }
    if (result.verdict === "passed") {
      const stamp = turnStamp(turnId, "completed");
      let prUrl: string | null = null;
      try {
        // The PR body carries the evidence — checks run, exit codes, commit sha —
        // so the verification contract is visible to anyone reading the PR rather
        // than living only in MongoDB. The ticket lookup, its parse and the body
        // write are INSIDE this try: a legacy ticket document or a full disk here
        // is the "verified but not published" state, and the catch below is the
        // path that already reports it that way. Outside, a throw here would have
        // reached the outer verification catch and reported a verified run as
        // verification_failed — with no hand-push hint and no mention of
        // publishing.
        const rawTicket = await database
          .collection<TicketDoc>("tickets")
          .findOne({ _id: new ObjectId(ticketId) });
        if (!rawTicket) {
          throw new ServerResultError("not_found", `ticket not found: ${ticketId}`);
        }
        const ticket = TicketSchema.parse(rawTicket);
        const bodyFile = `${runDir}/pr-body.md`;
        await writeFile(bodyFile, prBody(ticket, evidence, outSummary), "utf8");
        // A passed verdict on a branchless run cannot arise through the normal
        // flow (verifyRun needs a branch to check commits), but the schema
        // allows it. Refuse loudly rather than push an empty branch.
        if (run.branch === null) {
          throw new ServerResultError(
            "not_publishable",
            `run ${runId} reached a passed verdict with no branch to publish`,
          );
        }
        const published = await publishRun({
          board,
          title: `#${ticket.seq} ${ticket.title}`,
          workDir: run.workDir,
          branch: run.branch,
          bodyFile,
        });
        prUrl = published.prUrl;
      } catch (error) {
        // The verified commit exists only on a local branch, and the cleanup
        // path calls `git branch -D`. Do NOT clean up here: destroying verified
        // work because a network call failed is the worst outcome available.
        // The run is still `succeeded` — it WAS verified — so the failure
        // lives on the ticket, not the run.
        await runs.updateOne(
          { _id: new ObjectId(runId), status: "verifying" },
          {
            $set: {
              status: "succeeded",
              exitCode,
              summary: outSummary,
              verdict: "passed",
              finishedAt: doneAt,
              ...stamp.set,
            },
          },
          stamp.options,
        );
        await transitionTicketFailed(
          database, ticketId, runId, doneAt, "publish failed",
        );
        const handPush = run.branch
          ? ` Push by hand: git -C ${run.workDir} push -u origin ${run.branch}`
          : "";
        await notifyBlocked(
          database,
          ticketId,
          `verified but not published: ${error instanceof Error ? error.message : "unknown"}.${handPush}`,
          logFile,
          stderrFile,
        );
        return "completed";
      }
      // Published while still `verifying`, so a run observed `succeeded`
      // already carries its prUrl and the ticket is one quick write away from
      // `review_ready` — no window where a succeeded run leaves the ticket
      // stranded in `running`.
      await runs.updateOne(
        { _id: new ObjectId(runId), status: "verifying" },
        {
          $set: {
            status: "succeeded",
            exitCode,
            summary: outSummary,
            verdict: "passed",
            prUrl,
            finishedAt: doneAt,
            ...stamp.set,
          },
        },
        stamp.options,
      );
      await transitionTicketSucceeded(database, ticketId, runId, doneAt, prUrl);
      await notifyReviewReady(database, ticketId, `${outSummary ?? ""}\n${prUrl}`);
      return "completed";
    }
    const failing = result.checks.filter((c) => c.exitCode !== 0);
    const { loaded: failingWithOutput, anyUnreadable } =
      await failingChecksWithOutput(failing);
    const { decision, signature, attempts } =
      result.failureKind === "verification_failed"
        ? await deliverFixFeedback(runId, failingWithOutput, anyUnreadable)
        : ({
            decision: { retry: false, reason: "not_retryable" } as const,
            signature: "",
            attempts: 0,
          });
    const pendingFeedback: PendingFixFeedback = {
      message: formatCheckFailures(failingWithOutput),
      signature: signature || fixSignature(failingWithOutput),
      attempts,
    };

    if (decision.retry) {
      // Back to the agent on the existing leased session. The ticket stays
      // `running` — a retry is not a new state, it is the same run continuing.
      const rawRetryTicket = await database
        .collection<TicketDoc>("tickets")
        .findOne({ _id: new ObjectId(ticketId) });
      if (!rawRetryTicket) {
        throw new ServerResultError("not_found", `ticket not found: ${ticketId}`);
      }
      const retryTicket = TicketSchema.parse(rawRetryTicket);
      const leaseId = new ObjectId().toString();
      let sent: boolean;
      try {
        sent = await sendContinueTurn({
          database,
          run,
          board,
          ticket: retryTicket,
          runId,
          message: pendingFeedback.message,
          leaseId,
          // A retry is not answering a human's question: the run is mid-verification,
          // not parked. Pin `verifying` so an unrelated claim can never be resumed
          // by the fix loop, and leave the ticket untouched — it is already `running`.
          claimFilter: { _id: new ObjectId(runId), status: "verifying" },
          claimSet: {},
        });
      } catch {
        // The send threw — nothing was delivered, so nothing is recorded. Release
        // the lease and fall through to the suppressed tail: the run fails
        // visibly with reason `suppressed` rather than vanishing into
        // `verifying`. The outer catch would label it a verification error; the
        // real diagnosis is a fix that could not be delivered.
        await database
          .collection<RunDoc>("runs")
          .updateOne(
            { _id: new ObjectId(runId), executionLeaseId: leaseId },
            {
              $set: {
                executionLeaseId: null,
                executionLeaseExpiresAt: null,
              },
            },
          );
        return failSuppressedTail(
          database,
          runId,
          ticketId,
          turnId,
          pendingFeedback,
        );
      }
      // The send happened. Only now is the attempt recorded — budget consumed
      // and signature pinned for the next comparison. The CAS key is the parsed
      // `attempts` value deliverFixFeedback decided on, NOT the raw document
      // fetched before verifyRun (which predates the minutes of checks and was
      // never parsed): a legacy doc lacking the field would serialize to null,
      // match, and write NaN. Recording is the CAS'd write; a competing path
      // that already incremented the counter makes this update no-op, so two
      // concurrent deliveries cannot both count.
      if (sent) {
        await recordFixDelivery(runId, signature, attempts);
        return "completed";
      }
      // The claim was lost (the lease expired or a competing path claimed the
      // run between verification and this send). Nothing was delivered, so
      // nothing is recorded. Park the exact message for a later resumed turn.
      return failSuppressedTail(
        database,
        runId,
        ticketId,
        turnId,
        pendingFeedback,
      );
    }

    // A suppressed decision means the feedback could not be sent, not that the
    // failure was delivered or understood. Preserve it for a resumable session.
    if (decision.reason === "suppressed") {
      return failSuppressedTail(
        database,
        runId,
        ticketId,
        turnId,
        pendingFeedback,
      );
    }

    // A retry:false decision for budget exhaustion, a repeated signature, or a
    // non-retryable failure is terminal. The fix loop stops visibly.
    await failVerifiedRun(
      database,
      runId,
      result.failureKind ?? "verification_failed",
      exitCode,
      outSummary,
      doneAt,
      turnStamp(turnId, "completed"),
    );
    await transitionTicketFailed(database, ticketId, runId, doneAt, `verification ${result.failureKind}`);
    await notifyBlocked(
      database,
      ticketId,
      // Budget exhausted and a repeated failure are different diagnoses and must
      // not read the same — one says "it kept trying", the other "it gave up
      // because nothing changed". The count is the parsed `attempts` value the
      // decision was made from (deliverFixFeedback's `attempts`), already in
      // hand — no second database read. It distinguishes "gave up after N
      // attempts" from "stopped without trying", which is what the spec asks
      // notifyBlocked to carry.
      `verification failed (${result.failureKind}); fix loop stopped: ${decision.reason} after ${attempts} attempt${attempts === 1 ? "" : "s"}`,
      logFile,
      stderrFile,
    );
    return "completed";
  } catch (error) {
    await appendFile(
      logFile,
      `\nVerification error: ${error instanceof Error ? error.message : "unknown error"}\n`,
    ).catch(() => undefined);
    const failAt = now();
    await failVerifiedRun(
      database,
      runId,
      "verification_failed",
      exitCode,
      outSummary,
      failAt,
      turnStamp(turnId, "completed"),
    );
    await transitionTicketFailed(database, ticketId, runId, failAt, "verification error");
    await notifyBlocked(
      database,
      ticketId,
      "verification error",
      logFile,
      stderrFile,
    );
    return "completed";
  }
}

// Apply the completion, then close the turn. Every terminal branch of
// applyRunCompletion folds the turn's outcome into the SAME updateOne as the
// state change that outcome describes, so the outcome can never be observed
// later than the state it explains. This call is the BACKSTOP for the branches
// whose state CAS matched nothing (the run was terminalized underneath us) and
// therefore wrote no outcome either: the turn is still over and must not render
// as running forever. It is write-once, so when the folded write landed it is a
// no-op.
async function finishRun(
  runId: string,
  ticketId: string,
  phase: Phase,
  exitCode: number,
  stdout: string,
  logFile: string,
  stderrFile: string | null,
  board: Board,
  runDir: string,
  turnId: string,
): Promise<void> {
  const resolved = await applyRunCompletion(
    runId,
    ticketId,
    phase,
    exitCode,
    stdout,
    logFile,
    stderrFile,
    board,
    runDir,
    turnId,
  );
  const database = await db();
  await recordTurnOutcome(
    database.collection<RunDoc>("runs"),
    runId,
    turnId,
    resolved,
  );
}

async function monitorChild(
  child: RunningChild,
  runId: string,
  ticketId: string,
  phase: Phase,
  logFile: string,
  stderrFile: string | null,
  board: Board,
  runDir: string,
  turnId: string,
): Promise<void> {
  try {
    const [stdout, , exitCode] = await Promise.all([
      child.stdout,
      child.stderr,
      child.exited,
    ]);
    await finishRun(
      runId,
      ticketId,
      phase,
      exitCode,
      stdout,
      logFile,
      stderrFile,
      board,
      runDir,
      turnId,
    );
  } catch (error) {
    await appendFile(
      logFile,
      `\nSupervisor stream failure: ${error instanceof Error ? error.message : "unknown error"}\n`,
    ).catch(() => undefined);
    // Re-entry guard, mirroring the released-lease check in finishContinueTurn.
    // The first pass writes a turn's outcome in the SAME update as the state it
    // implies, so an outcome already present PROVES that state was applied.
    // Re-running finishRun with a synthetic exit -1 would then fail a run that is
    // legitimately parked and clear its ticket's activeRunId, dead-ending a
    // needs_input ticket whose only outgoing edge needs that pointer.
    const settled = await (await db())
      .collection<RunDoc>("runs")
      .findOne({
        _id: new ObjectId(runId),
        turns: { $elemMatch: { id: turnId, outcome: { $ne: null } } },
      });
    if (settled) return;
    await finishRun(
      runId,
      ticketId,
      phase,
      -1,
      "",
      logFile,
      stderrFile,
      board,
      runDir,
      turnId,
    );
  }
}

async function restoreParkedResume(
  database: Db,
  run: RunDoc,
  runId: string,
  question: string | null,
): Promise<void> {
  const at = now();
  const runs = database.collection<RunDoc>("runs");
  const parkedRunState = {
    status: "awaiting_input" as const,
    // Restore the park EXACTLY as it was. This is the compensation path for
    // continueExecution too, so hardcoding "question" would downgrade a
    // `continued` park — and resumeRun, which is fail-closed, would then accept
    // and terminalize a perfectly healthy continuable run.
    parkedBy: run.parkedBy ?? ("question" as const),
    awaitingQuestion: question,
    pid: null,
    startedAt: run.startedAt,
  };
  // Restore the parked status and its open row in one document write. A
  // concurrent retry must never observe awaiting_input without an open
  // exchange and claim the run before the row is reopened.
  const restored = await runs.updateOne(
    {
      _id: new ObjectId(runId),
      status: { $in: ["running", "queued"] },
      exchanges: { $not: { $elemMatch: { answer: null } } },
    },
    {
      $set: parkedRunState,
      $push: {
        exchanges: {
          $each: [
            {
              v: 1 as const,
              at,
              // Keep compensation rows valid when legacy data lacks a question.
              question: questionOrFallback(question, "(question unavailable)"),
              handoff: null,
              answer: null,
              answeredAt: null,
            },
          ],
          $slice: -EXCHANGE_CAP,
        },
      },
    },
  );
  if (restored.matchedCount === 0) {
    // If the claim failed before writing, the original row is still open.
    // Restore status only rather than manufacturing a second open exchange.
    // Guard against a run that was already terminalized while we raced.
    const fallback = await runs.updateOne(
      { _id: new ObjectId(runId), status: { $in: ["running", "queued"] } },
      { $set: parkedRunState },
    );
    // The run is gone. The ticket half MUST be skipped, not merely "returned
    // past": a needs_input ticket whose activeRunId points at a terminalized run
    // has no legal way out — needs_input's only outgoing edge is provide_input,
    // which resumeRun rejects, and dispatchRun refuses a non-null activeRunId.
    // Sequential, not Promise.all: array literals evaluate eagerly, so a ticket
    // update sitting beside this one would fire no matter what we return.
    if (fallback.matchedCount === 0) return;
  }
  await database.collection<TicketDoc>("tickets").updateOne(
    { _id: new ObjectId(run.ticketId), activeRunId: runId },
    {
      $set: {
        status: "needs_input",
        activeRunId: runId,
        updatedAt: at,
      },
    },
  );
}

export async function resumeRun(runId: string, answer: string): Promise<void> {
  const database = await db();
  const runs = database.collection<RunDoc>("runs");
  const run = await runs.findOne({ _id: new ObjectId(runId) });
  if (!run || run.status !== "awaiting_input") {
    throw new ServerResultError("conflict", "run is not awaiting input");
  }
  if (!run.executionSessionId) {
    throw new ServerResultError(
      "conflict",
      "run has no captured session to resume",
    );
  }
  if (run.parkedBy === "continued") {
    throw new ServerResultError(
      "conflict",
      "run was parked by a continued turn; use continue execution instead",
    );
  }

  const rawBoard = await database.collection<BoardDoc>("boards").findOne({
    _id: new ObjectId(run.boardId),
  });
  if (!rawBoard) {
    throw new ServerResultError("not_found", `board not found: ${run.boardId}`);
  }
  const board = BoardSchema.parse(rawBoard);
  const rawTicket = await database.collection<TicketDoc>("tickets").findOne({
    _id: new ObjectId(run.ticketId),
  });
  if (!rawTicket) {
    throw new ServerResultError(
      "not_found",
      `ticket not found: ${run.ticketId}`,
    );
  }
  const ticket = TicketSchema.parse(rawTicket);
  if (ticket.status !== "needs_input" || ticket.activeRunId !== runId) {
    throw new ServerResultError(
      "conflict",
      "ticket is not parked on this run",
    );
  }

  const runDir = `${board.repoPath}/.tosin4dev/runs/${runId}`;
  const outcomePath = `${runDir}/outcome.json`;
  const pendingFeedback = run.pendingFixFeedback;
  const resumeMessage = pendingFeedback
    ? `${answer}\n\n${pendingFeedback.message}`
    : answer;
  const brief: RunnerBrief = {
    ticket,
    board,
    workDir: run.workDir,
    phase: run.phase,
    outcomePath,
    resume: { sessionId: run.executionSessionId, answer: resumeMessage },
  };

  let child: ChildProcess | undefined;
  let runningChild: RunningChild | undefined;
  const answeredAt = now();
  const exchanges = run.exchanges ?? [];
  let openIndex = -1;
  exchanges.forEach((exchange, index) => {
    if (exchange.answer === null) openIndex = index;
  });
  const openRow = openIndex >= 0 ? exchanges[openIndex] : null;
  // Pin the exact row being answered. Array filters throw when `exchanges` is
  // absent on a pre-v5 run and would fan one answer across every open row.
  const claimFilter: Filter<RunDoc> = {
    _id: new ObjectId(runId),
    status: "awaiting_input",
  };
  if (openIndex >= 0 && openRow) {
    // Real row-level CAS. `{$type:"null"}` NOT `null`: plain equality-to-null
    // also matches MISSING, and a numeric path component is ambiguous (index vs
    // literal field name), so `{"exchanges.N.answer": null}` matches ANY doc
    // with an exchanges array — it is a no-op. The `at` identity term pins the
    // exact row we snapshotted, so a concurrent park + $slice front-eviction
    // (which shifts every index down) cannot land this answer on a different
    // question.
    const filter = claimFilter as Record<string, unknown>;
    filter[`exchanges.${openIndex}.answer`] = { $type: "null" };
    filter[`exchanges.${openIndex}.at`] = openRow.at;
  } else {
    // A legacy snapshot has no open row. Pin both that absence and its parked
    // question so a stale claim cannot answer a different, newly parked row.
    const filter = claimFilter as Record<string, unknown>;
    filter.exchanges = { $not: { $elemMatch: { answer: null } } };
    filter.awaitingQuestion = run.awaitingQuestion ?? null;
  }
  // The answer MUST remain inside this claim: a second write could fail after
  // status changes to running, losing the human answer with no safe retry.
  const claimed = await runs
    .updateOne(
      claimFilter,
      {
        $set: {
          status: "running",
          startedAt: answeredAt,
          ...(openIndex >= 0
            ? {
                [`exchanges.${openIndex}.answer`]: answer,
                [`exchanges.${openIndex}.answeredAt`]: answeredAt,
              }
            : {}),
        },
        ...(openIndex === -1
          ? {
              $push: {
                exchanges: {
                  $each: [
                    {
                      v: 1 as const,
                      at: answeredAt,
                      question: questionOrFallback(
                        run.awaitingQuestion,
                        "(question unavailable)",
                      ),
                      handoff: null,
                      answer,
                      answeredAt,
                    },
                  ],
                  $slice: -EXCHANGE_CAP,
                },
              },
            }
          : {}),
      },
    )
    .catch(async () => {
      try {
        await restoreParkedResume(database, run, runId, run.awaitingQuestion);
      } catch (compensationError) {
        console.error(
          `Failed to restore parked run ${runId} after claim failure:`,
          compensationError,
        );
      }
      throw new ServerResultError("spawn_failed", "run could not be resumed");
    });
  if (claimed.matchedCount === 0) {
    throw new ServerResultError("conflict", "run left awaiting_input");
  }

  try {
    // The run claim serializes answers. Clear the stale outcome and rewrite
    // the prompt before spawn; any failure below restores the parked pair.
    await rm(outcomePath, { force: true });
    await writeFile(run.promptFile, buildPrompt(brief));

    // Record the resume turn before spawning: index continues where the run's
    // turn history left off. Persist via $push so dispatch turn 0 (inserted
    // with the run) is never disturbed.
    const resumeTurnId = new ObjectId().toString();
    const resumeTurnPaths = turnPaths(runDir, resumeTurnId);
    const resumeTurn: RunTurn = {
      v: 1,
      id: resumeTurnId,
      index: (run.turns?.length ?? 0),
      at: now(),
      kind: "resume",
      outcome: null,
      stdoutFile: resumeTurnPaths.stdoutFile,
      stderrFile: resumeTurnPaths.stderrFile,
    };
    await mkdir(resumeTurnPaths.turnDir, { recursive: true });
    await writeFile(resumeTurn.stdoutFile, "");
    await writeFile(resumeTurn.stderrFile, "");

    const command = adapters[run.runner].buildCommand(brief, run.promptFile);
    const spawnedChild = spawn(command.cmd[0], command.cmd.slice(1), {
      cwd: run.workDir,
      env: {
        ...process.env,
        ...command.env,
        T4D_OUTCOME_PATH: outcomePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawnedChild;
    runningChild = {
      stdout: drainStream(
        spawnedChild.stdout,
        [run.logFile, resumeTurn.stdoutFile],
        true,
      ),
      stderr: drainStream(
        spawnedChild.stderr,
        [run.stderrFile ?? run.logFile, resumeTurn.stderrFile],
        false,
      ),
      exited: settledExit(spawnedChild),
    };
    void Promise.all([
      runningChild.stdout,
      runningChild.stderr,
      runningChild.exited,
    ]).catch(() => undefined);
    await waitForSpawn(spawnedChild);

    const runStarted = await runs.updateOne(
      { _id: new ObjectId(runId), status: "running" },
      { $set: { pid: spawnedChild.pid, awaitingQuestion: null } },
    );
    if (runStarted.matchedCount === 0) {
      throw new ServerResultError("conflict", "run left running");
    }

    // The public ticket transition becomes final only after spawn is live and
    // the run record carries its pid. Until this update, the ticket stays
    // needs_input with activeRunId intact.
    const at = now();
    const to = transition("needs_input", "provide_input");
    const ticketStarted = await database
      .collection<TicketDoc>("tickets")
      .updateOne(
        {
          _id: new ObjectId(run.ticketId),
          status: "needs_input",
          activeRunId: runId,
        },
        {
          $set: { status: to, updatedAt: at },
          $push: pushActivity("input", `answered: ${answer}`, at),
        },
      );
    if (ticketStarted.matchedCount === 0) {
      throw new ServerResultError(
        "conflict",
        "ticket is no longer awaiting input",
      );
    }
    // The turn row is pushed LAST, after every write that can still throw. A row
    // pushed earlier and then abandoned by the catch below keeps `outcome: null`
    // forever — restoreParkedResume knows nothing about turns, so a healthy,
    // re-parked, operator-facing run would render that turn "running" for good
    // and flip every later turn's eof true → false → true. A turn row exists
    // only once a monitor is guaranteed to close it.
    const turnRecorded = await runs.updateOne(
      { _id: new ObjectId(runId), status: "running" },
      { $push: { turns: { $each: [resumeTurn], $slice: -TURN_CAP } } },
    );
    if (turnRecorded.matchedCount === 0) {
      throw new ServerResultError("conflict", "run left running");
    }
    if (pendingFeedback) {
      await recordFixDelivery(
        runId,
        pendingFeedback.signature,
        pendingFeedback.attempts,
        pendingFeedback.signature,
      );
    }

    void monitorChild(
      runningChild,
      runId,
      run.ticketId,
      run.phase,
      run.logFile,
      run.stderrFile,
      board,
      runDir,
      resumeTurnId,
    ).catch((error) =>
      console.error(`Resume monitor failed for run ${runId}:`, error),
    );
  } catch {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await runningChild?.exited.catch(() => undefined);
    }
    try {
      await restoreParkedResume(database, run, runId, run.awaitingQuestion);
    } catch (compensationError) {
      console.error(
        `Failed to restore parked run ${runId} after spawn failure:`,
        compensationError,
      );
    }
    throw new ServerResultError("spawn_failed", "run could not be resumed");
  }
}

// Resolve a finished continue turn. A declared outcome (completed / needs_input /
// failed) hands off to the EXISTING finishRun path so verification behaves
// identically to a normal resume. A process that exited 0 without producing a
// usable outcome is a `continued` turn: release the lease, keep no verdict, and
// re-park the run awaiting a further human turn.
async function finishContinueTurn(
  runId: string,
  run: RunDoc,
  board: Board,
  runDir: string,
  leaseId: string,
  turnId: string,
  stdout: string,
  exitCode: number,
): Promise<void> {
  const database = await db();
  const runs = database.collection<RunDoc>("runs");
  const outcome = await readOutcome(runDir);
  // readOutcome fails closed: a missing/invalid outcome.json reads as `failed`
  // with one of these sentinel reasons. Only a runner that actually declared a
  // `failed` outcome counts as a usable failure; the rest is "no usable outcome".
  const usable = !(
    outcome.outcome === "failed" &&
    (outcome.reason === "no outcome.json written" ||
      outcome.reason === "invalid outcome.json")
  );
  let resolved: Exclude<RunTurn["outcome"], null> = "failed";
  let continued = false;
  if (usable) {
    resolved = outcome.outcome;
  } else if (exitCode === 0) {
    resolved = "continued";
    continued = true;
  }

  const at = now();

  if (!continued) {
    // Every terminal outcome hands off to finishRun, which owns all
    // status/verdict/ticket transitions. But it must not leave the execution
    // lease live: a stale lease would reject the next continueExecution with
    // "run is already executing", breaking the back-and-forth loop. Release it
    // here, before finishRun, so the re-parked run is immediately continuable.
    const released = await runs.updateOne(
      { _id: new ObjectId(runId), executionLeaseId: leaseId },
      {
        $set: {
          executionLeaseId: null,
          executionLeaseExpiresAt: null,
        },
      },
    );
    // The release doubles as this turn's fencing token. If it matched nothing
    // the lease already moved to a newer turn, so this turn owns nothing —
    // finishRun would otherwise terminalize the run and ticket underneath the
    // live one. The turn is over even though it lost its claim. Record its
    // outcome — the id is unique to this turn, so this touches nothing the
    // winning turn owns.
    if (released.matchedCount === 0) {
      await recordTurnOutcome(runs, runId, turnId, resolved);
      return;
    }

    await finishRun(
      runId,
      run.ticketId,
      run.phase,
      exitCode,
      stdout,
      run.logFile,
      run.stderrFile,
      board,
      runDir,
      turnId,
    );
    return;
  }

  // continued: a re-park, nothing more. No verification, no verdict, no
  // finishedAt, and the ticket is not moved toward review.
  //
  // The agent continued without asking anything, so there is no real question to
  // park on. Open a fresh exchange row for the next human turn instead of leaving
  // `awaitingQuestion` null — the schema's invariant is that a parked run has
  // exactly one open row and `awaitingQuestion` denormalises it.
  const continuedQuestion =
    "(agent continued without asking a question)";
  // --resume forks a new session id on every turn, and `continued` is the path
  // designed to repeat. Without re-capturing it here the next turn resumes the
  // session as it stood BEFORE this one, silently discarding this turn.
  const rotatedSessionId = parseSessionId(run.runner, stdout);
  // Same rule as every other park: the outcome rides the update that publishes
  // the park, never a later one.
  const reparkStamp = turnStamp(turnId, resolved);
  // The compensation paths below fail the run instead of parking it, so the turn
  // they stamp must read `failed`, not `resolved`.
  const failedStamp = turnStamp(turnId, "failed");
  const reparked = await runs.updateOne(
    {
      _id: new ObjectId(runId),
      executionLeaseId: leaseId,
      // Never resurrect a run that recoverOrphans (or any other path) already
      // terminalized while this turn was in flight.
      exchanges: { $not: { $elemMatch: { answer: null } } },
      status: "running",
    },
    {
      $set: {
        status: "awaiting_input",
        parkedBy: "continued",
        awaitingQuestion: continuedQuestion,
        // The child is gone; a stale pid reads as alive after PID recycling.
        pid: null,
        executionLeaseId: null,
        executionLeaseExpiresAt: null,
        ...(rotatedSessionId ? { executionSessionId: rotatedSessionId } : {}),
        ...reparkStamp.set,
      },
      $push: {
        exchanges: {
          $each: [
            {
              v: 1 as const,
              at,
              question: continuedQuestion,
              handoff: null,
              answer: null,
              answeredAt: null,
            },
          ],
          $slice: -EXCHANGE_CAP,
        },
      },
    },
    reparkStamp.options,
  );
  if (reparked.matchedCount === 0) {
    // Terminalize BEFORE releasing the lease, and clear the lease in the SAME
    // update. Released first, the lease is free the instant this turn stops
    // owning the run: continueExecution can legitimately claim it and spawn turn
    // N+1, putting the run back to `running` — and an unfenced `status:
    // "running"` terminalize would then match and fail a run with a live child.
    // Pinning `executionLeaseId` keeps every write in this branch inside the
    // window this turn owns. The `status: "running"` term still makes this a
    // no-op when the run was already terminalized underneath us — the other way
    // this CAS misses.
    const terminalized = await runs.updateOne(
      { _id: new ObjectId(runId), status: "running", executionLeaseId: leaseId },
      {
        $set: {
          status: "failed",
          failureKind: "runner_exit",
          finishedAt: at,
          summary: "run could not be re-parked between turns",
          executionLeaseId: null,
          executionLeaseExpiresAt: null,
          // The child is gone; a stale pid reads as alive after PID recycling.
          pid: null,
          // The run this turn produced is `failed`, so `failed` is what the
          // persisted turn must say. Stamping `resolved` (`continued`) here
          // would leave a history that claims the turn carried on.
          ...failedStamp.set,
        },
      },
      failedStamp.options,
    );
    if (terminalized.matchedCount > 0) {
      // A ticket left `running` behind a dead run has no legal way out:
      // gatesForStatus offers nothing, no public event has an edge from
      // `running`, and dispatchRun refuses a non-null activeRunId. Every sibling
      // failure path uses transitionTicketFailed, which moves it to `blocked` —
      // the status the operator is about to be notified about, and the one with
      // a `resume` gate.
      await transitionTicketFailed(
        database,
        run.ticketId,
        runId,
        at,
        "run could not be re-parked between turns",
      );
      await notifyBlocked(
        database,
        run.ticketId,
        "run could not be re-parked between turns",
        run.logFile,
        run.stderrFile,
      );
      return;
    }
    // The run is no longer `running` under our lease. Either a newer turn owns
    // it — in which case the release below matches nothing and we touch nothing
    // that turn owns — or it was terminalized while we were in flight and the
    // lease is still ours, and returning with it held strands the run: the next
    // continueExecution is rejected with "run is already executing" and nothing
    // clears it until a process restart runs recoverOrphans.
    await runs.updateOne(
      { _id: new ObjectId(runId), executionLeaseId: leaseId },
      {
        $set: {
          executionLeaseId: null,
          executionLeaseExpiresAt: null,
          // The child is gone; a stale pid reads as alive after PID recycling.
          pid: null,
        },
      },
    );
    // This turn is over either way, and its id is unique to it, so recording its
    // real outcome touches nothing a winning turn owns.
    await recordTurnOutcome(runs, runId, turnId, resolved);
    return;
  }

  const to = transition("running", "run_needs_input");
  const ticketReparked = await database
    .collection<TicketDoc>("tickets")
    .updateOne(
      { _id: new ObjectId(run.ticketId), activeRunId: runId, status: "running" },
      {
        $set: { status: to, updatedAt: at },
        $push: pushActivity("run", "continued execution pending", at),
      },
    );
  if (ticketReparked.matchedCount === 0) {
    // The ticket moved underneath us (archived, failed, reassigned). Leaving the
    // run parked would strand it: nothing sweeps `awaiting_input`, and every entry
    // point rejects a run whose ticket no longer owns it. Terminalize it instead.
    await runs.updateOne(
      { _id: new ObjectId(runId), status: "awaiting_input" },
      {
        $set: {
          status: "failed",
          failureKind: "runner_exit",
          finishedAt: at,
          summary: "ticket moved while the run was parked between turns",
          // The re-park above landed, so it already stamped this turn
          // `continued` and the write-once array filter makes this a no-op on
          // that path. It is here for the same reason the filter is: whatever
          // stamp does land must describe the run this update leaves behind.
          ...failedStamp.set,
        },
      },
      failedStamp.options,
    );
    await database
      .collection<TicketDoc>("tickets")
      .updateOne(
        { _id: new ObjectId(run.ticketId), activeRunId: runId },
        { $set: { activeRunId: null, updatedAt: at } },
      );
    // The run is dead. Record the turn and tell the operator the truth: falling
    // through to the "awaiting input" notice below announces that a terminalized
    // run is waiting for a message nothing will ever accept.
    await recordTurnOutcome(runs, runId, turnId, resolved);
    await notifyBlocked(
      database,
      run.ticketId,
      "ticket moved while the run was parked between turns",
      run.logFile,
      run.stderrFile,
    );
    return;
  }
  await recordTurnOutcome(runs, runId, turnId, resolved);
  // Every other park in this file notifies. A silently parked run waits forever.
  await notify(
    `⏸️ continued, awaiting input: ${await ticketLabel(database, run.ticketId)}`,
  );
}

// The message that rides the resume slot is what buildPrompt interpolates into
// the "human answered" section. The fix loop reuses the same slot with the
// acceptance-check failure text, so the agent reads it as the operator's reply.
//
// This function only DECIDES. Recording the attempt (budget increment +
// signature) is the caller's job, done AFTER the send actually delivered
// feedback — the send has three ways to deliver nothing, and a decision that
// delivered nothing must not look like a delivery or the next call misjudges on
// stale state. Alongside the decision it returns the parsed `attempts` value it
// decided on, so the caller's delivery CAS keys on the exact snapshot that was
// read — not a second, unparsed read taken before verifyRun.
export async function deliverFixFeedback(
  runId: string,
  failing: { key: string; exitCode: number; output: string }[],
  anyUnreadable = false,
): Promise<{
  decision: FixDecision;
  signature: string;
  // The parsed `fixAttempts` the decision was made FROM. The verification tail
  // keys its delivery CAS on this value so the write matches only the document
  // the decision actually read — a legacy doc that lacks the field (its schema
  // default never ran because the doc was never re-parsed) would otherwise
  // serialize `undefined` to `null` and match anyway, then write `NaN`.
  attempts: number;
}> {
  const database = await db();
  const runs = database.collection<RunDoc>("runs");
  const raw = await runs.findOne({ _id: new ObjectId(runId) });
  if (!raw) {
    return {
      decision: { retry: false, reason: "not_retryable" },
      signature: "",
      attempts: 0,
    };
  }
  const run = RunSchema.parse(raw);

  // Suppressed, not sent. A parked run cannot receive a turn, and marking this
  // delivered would leave the agent waiting on advice it never got. Fail closed:
  // no budget consumed, no signature recorded, so it re-fires on resume.
  if (run.status === "awaiting_input") {
    return {
      decision: { retry: false, reason: "suppressed" },
      signature: "",
      attempts: run.fixAttempts,
    };
  }

  // A retry resumes the SAME provider session. Without a captured session id
  // there is nothing to resume, so the failure is not fixable by a retry — fail
  // closed rather than let the send machinery throw after the budget was spent.
  if (!run.executionSessionId) {
    return {
      decision: { retry: false, reason: "not_retryable" },
      signature: "",
      attempts: run.fixAttempts,
    };
  }

  const signature = fixSignature(failing);
  // An unreadable log means the signature was computed over content we could not
  // read — not evidence the agent saw this exact failure before. Stop only on the
  // budget guard in that case; never on a comparison against a previous
  // signature, which would convert a logging failure into a wrong verdict.
  const decision = decideFix({
    failureKind: "verification_failed",
    attempts: run.fixAttempts,
    signature,
    lastSignature: anyUnreadable ? null : run.lastFixSignature,
  });
  if (!decision.retry) return { decision, signature, attempts: run.fixAttempts };

  // The branch tip moved while checks were running, so these failures describe a
  // commit that no longer exists. Delivering them would be a lie: the agent
  // would be asked to fix a commit that is not there. The latest evidence row
  // for this run records the commit that was verified; no row means verification
  // never produced a commit to guard. When a row exists, the git read below
  // decides. An unreadable tip (workdir gone, transient error) is NOT evidence
  // the commit is still there — the whole point of the guard is to never hand
  // the agent failures from a commit that no longer exists — so it fails CLOSED
  // and the feedback is suppressed. The verification outcome is not lost: the
  // run still fails visibly through the blocked path with reason `suppressed`.
  const latestEvidence = await database
    .collection<Evidence>("evidence")
    .findOne({ runId }, { sort: { createdAt: -1 } });
  if (latestEvidence && run.branch !== null) {
    // Parse the row at the boundary: this read gates the guard below, and an
    // untyped `any` commitSha would silently compare `undefined !== tipNow`,
    // suppressing every retry forever, if the field were ever renamed.
    const evidence = EvidenceSchema.pick({ commitSha: true }).parse(latestEvidence);
    let tipNow: string | null = null;
    try {
      tipNow = (
        await execFileAsync("git", ["-C", run.workDir, "rev-parse", "HEAD"], {
          encoding: "utf8",
        })
      ).stdout.trim();
    } catch {
      tipNow = null;
    }
    if (tipNow !== evidence.commitSha) {
      return {
        decision: { retry: false, reason: "suppressed" },
        signature,
        attempts: run.fixAttempts,
      };
    }
  }

  // The decision alone — the attempt is recorded by recordFixDelivery only after
  // the send actually delivered the feedback, never before.
  return { decision, signature, attempts: run.fixAttempts };
}

// Record a fix delivery that actually happened. Called by the verification tail
// ONLY after sendContinueTurn returns true. The CAS on fixAttempts keeps two
// concurrent paths from both incrementing: the write matches only the value the
// decision was parsed from (deliverFixFeedback's `attempts`), so the loser's
// update no-ops.
async function recordFixDelivery(
  runId: string,
  signature: string,
  fixAttempts: number,
  pendingSignature?: string,
): Promise<void> {
  const database = await db();
  // RunSchema has no `updatedAt` field; a previous write set it here and it was
  // stripped on every parse. Drop it so the write only touches typed fields.
  //
  // The value comes from deliverFixFeedback's RunSchema.parse, which rejects
  // NaN. A key of 0 must ALSO match a document that genuinely lacks the field:
  // for a counter that has never been written, absent and zero are the same
  // state, and `{ fixAttempts: 0 }` does not match an absent field in Mongo —
  // only `null` / `$exists: false` does. A legacy run whose fixAttempts was
  // never written would otherwise never match, the delivery would land nowhere,
  // and every failed verification would retry forever. `$in` widens only the
  // zero case; every non-zero key stays exact so two concurrent paths cannot
  // both increment. One delivery repairs the document permanently.
  const filter: Filter<RunDoc> = {
    _id: new ObjectId(runId),
    // `Filter<RunDoc>` types fixAttempts as number, which would reject null in
    // `$in`, so widen only the value. `_id` and the field name stay type-checked:
    // if fixAttempts were renamed in RunDoc, this filter would fail to compile
    // instead of silently matching nothing.
    fixAttempts: (fixAttempts === 0 ? { $in: [0, null] } : fixAttempts) as unknown as number,
  };
  if (pendingSignature !== undefined) {
    (filter as Record<string, unknown>)["pendingFixFeedback.signature"] = pendingSignature;
  }
  const matched = await database.collection<RunDoc>("runs").updateOne(
    filter,
    {
      $set: {
        fixAttempts: fixAttempts + 1,
        lastFixSignature: signature,
        ...(pendingSignature !== undefined ? { pendingFixFeedback: null } : {}),
      },
    },
  );
  if (matched.matchedCount === 0) {
    console.error(
      `recordFixDelivery matched no run for ${runId} at fixAttempts ${fixAttempts}; ` +
        "did not count this delivery (expected if a concurrent path already recorded one)",
    );
  }
}

// The pure fix-loop module needs each failing check's CONTENT, but verifyRun
// persists check output to `<runDir>/checks/<key>.log` and returns only the
// path. Read those logs back at the boundary. A log that cannot be read (missing
// after a crash, cleaned up, permission denied) contributes an empty string so
// the agent still sees the check key and exit code even without its output —
// losing the whole verification outcome because a log vanished is the worse
// failure.
//
// An unreadable log MUST also make the whole load "incomplete". Two different
// failures whose logs are both unreadable would otherwise contribute identical
// empty strings, hash to the same signature, and stop the loop with a wrong
// repeated_failure verdict for a failure the agent has never seen. A signature
// computed over content we could not read is not evidence the agent saw the
// same failure twice, so the caller skips the dedup comparison whenever any log
// was unreadable and falls back to the budget guard alone.
export async function failingChecksWithOutput(
  checks: { key: string; exitCode: number; outputRef: string }[],
): Promise<{
  loaded: { key: string; exitCode: number; output: string }[];
  anyUnreadable: boolean;
}> {
  const loaded: { key: string; exitCode: number; output: string }[] = [];
  let anyUnreadable = false;
  for (const check of checks) {
    let output = "";
    try {
      output = await readFile(check.outputRef, "utf8");
    } catch {
      output = "";
      anyUnreadable = true;
    }
    loaded.push({ key: check.key, exitCode: check.exitCode, output });
  }
  return { loaded, anyUnreadable };
}

// What the agent actually receives. Only failing checks, each with its command
// and the tail of its output — the whole log would bury the signal.
function formatCheckFailures(
  failing: { key: string; exitCode: number; output: string }[],
): string {
  const blocks = failing.map(
    (c) =>
      `Check "${c.key}" failed with exit code ${c.exitCode}:\n${c.output.slice(-FIX_SIGNATURE_TAIL_BYTES)}`,
  );
  return [
    "Your commit did not pass this board's acceptance checks.",
    ...blocks,
    "Fix the cause, commit again on the same branch, and do not push.",
  ].join("\n\n");
}

// Neutralize GitHub control tokens in text that lands in a public PR body.
// An `@someone` in a spec would mass-notify that user or team, and a
// `Closes #123` would attach auto-close semantics to an unrelated issue when
// the PR merges — both are plausible in a human-written ticket describing an
// issue. Both resolve inside blockquotes, so the tokens themselves are broken:
// a zero-width space between the marker and its target stops GitHub from
// resolving them while the text stays human-readable. Backtick-wrapping would
// work too but fails on text that already contains backticks (a broken code
// span leaks the rest as formatting), so the zero-width form is the robust one.
//
// Closing forms neutralized: any keyword GitHub honours (close/closes/closed,
// fix/fixes/fixed, resolve/resolves/resolved, any case) followed by `:` or
// whitespace, then one of `#N`, `GH-N`, `owner/repo#N`, or an issue URL. The
// cross-repo `owner/repo#N` form matters most: "Closes publyapp/api#412"
// would close an issue in a DIFFERENT repository when the PR merges. Not
// handled: a bare keyword with no reference (nothing to break) and a bare
// `#N` with no keyword (auto-close needs the keyword, and breaking every
// `#N` would corrupt ordinary issue references in prose).
//
// The @-guard only fires where GitHub would actually resolve a mention: an @
// at a token start (start-of-string or after whitespace), so `t@example.com`
// is left alone, and not on a handle that ends in a dotted TLD (`@gmail.com`
// reads as an email). Code spans and fenced blocks are extracted first and
// skipped whole, so `npm i @types/node` stays copy-pasteable and GitHub does
// not resolve mentions or close issues from inside a code block. This is
// deliberately not a full markdown parse — that is out of scope and out of
// proportion. The residual case is an unbalanced backtick (a stray ` with no
// closer): the splitter treats the rest as prose and its @ tokens still get
// a ZWSP.
function neutralizeProse(prose: string): string {
  return prose
    .replace(
      /(?:^|(?<=\s))@([A-Za-z0-9][A-Za-z0-9._-]*)/gm,
      (whole, handle) =>
        /\.[A-Za-z]{2,}$/.test(handle) ? whole : `@\u200b${handle}`,
    )
    .replace(
      /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?:[ \t]*:[ \t]*|[ \t]+)(?:#\d+|GH-\d+|[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+|https?:\/\/\S+\/issues\/\d+)\b/gi,
      (whole) => whole.replace(/(\d+)$/, "\u200b$1"),
    );
}

export function neutralizePrTokens(text: string): string {
  // The spans are stashed and re-inserted after neutralizing so the
  // surrounding prose keeps its original character positions: an @ that
  // directly follows a closing backtick is not a token start and is left
  // alone, and a closing keyword cannot reach across a code span.
  const code: string[] = [];
  const prose = text.replace(/(```[\s\S]*?```|`[^`\n]*`)/g, (span) => {
    code.push(span);
    return `\u0000${code.length - 1}\u0000`;
  });
  return neutralizeProse(prose).replace(
    /\u0000(\d+)\u0000/g,
    (placeholder, i) => code[Number(i)] ?? placeholder,
  );
}

// Assembled from what already exists: the locked spec, the run summary, and the
// evidence row. No new state. Exported as a pure seam so the token
// neutralization is testable without a publish.
export function prBody(
  ticket: Ticket,
  evidence: Evidence,
  summary: string | null,
): string {
  const checks = evidence.checks
    .map((c) => `- \`${c.key}\` — exit ${c.exitCode}`)
    .join("\n");
  return [
    `### Intent\n${neutralizePrTokens(ticket.spec.intent)}`,
    ticket.spec.acceptance.length
      ? `### Acceptance\n${ticket.spec.acceptance.map((a) => `- ${neutralizePrTokens(a)}`).join("\n")}`
      : null,
    summary ? `### Summary\n${neutralizePrTokens(summary)}` : null,
    `### Verification\nCommit \`${evidence.commitSha}\`\n\n${checks || "_no checks recorded_"}`,
    `_Opened by Tosin4dev. Draft — merging is the owner's action._`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function monitorContinue(
  child: RunningChild,
  runId: string,
  run: RunDoc,
  board: Board,
  runDir: string,
  leaseId: string,
  turnId: string,
): Promise<void> {
  try {
    const [stdout, , exitCode] = await Promise.all([
      child.stdout,
      child.stderr,
      child.exited,
    ]);
    await finishContinueTurn(
      runId,
      run,
      board,
      runDir,
      leaseId,
      turnId,
      stdout,
      exitCode,
    );
  } catch (error) {
    await appendFile(
      run.logFile,
      `\nSupervisor continue stream failure: ${error instanceof Error ? error.message : "unknown error"}\n`,
    ).catch(() => undefined);
    await finishContinueTurn(runId, run, board, runDir, leaseId, turnId, "", -1);
  }
}

// Send one `continue` turn to a run. The caller owns the precondition (which
// state the run must be in to claim it) and the spawn-failure compensation; this
// owns the lease claim, prompt rewrite, turn record, spawn, stream drain,
// ticket transition hook, turn push, and monitor handoff.
//
// `claimFilter`/`claimSet`/`claimPush` encode the caller's precondition:
// continueExecution pins the parked row + open exchange so the human's message
// lands on the question they saw; the fix loop pins `verifying` so a retry
// resumes a run mid-verification. The lease terms are appended here so every
// claim is fenced identically. `afterRunStarted` runs in the window between the
// pid being published and the turn row being pushed — the only place a ticket
// move can land without leaking an uncloseable turn row.
// Returns true when the turn was claimed AND sent; false when the caller's
// claim missed (run was terminalized underneath, lease lost, precondition no
// longer holds). A miss is not an error: nothing was claimed, so no
// compensation is due — the caller decides what a lost race means for its own
// precondition (continueExecution reports `conflict`, the fix loop treats the
// run as already terminalized).
async function sendContinueTurn(opts: {
  database: Db;
  run: RunDoc;
  board: Board;
  ticket: Ticket;
  runId: string;
  message: string;
  leaseId: string;
  claimFilter: Filter<RunDoc>;
  claimSet: Record<string, unknown>;
  claimPush?: PushOperator<RunDoc>;
  afterRunStarted?: () => Promise<void>;
}): Promise<boolean> {
  const {
    database,
    run,
    board,
    ticket,
    runId,
    message,
    leaseId,
    claimFilter,
    claimSet,
    claimPush,
    afterRunStarted,
  } = opts;
  const runs = database.collection<RunDoc>("runs");
  // A retry and a human continue both resume the SAME provider session; without
  // one there is nothing to send. Checked before the claim so a session-less run
  // is never half-claimed.
  if (!run.executionSessionId) {
    throw new ServerResultError(
      "conflict",
      "run has no captured session to continue",
    );
  }
  // Claim the run's execution lease in ONE atomic update. The caller's filter
  // pins its precondition; the `$or` here refuses a run with a live lease, so a
  // loser never overwrites a turn in flight.
  const claimAt = now();
  const claimed = await runs.updateOne(
    {
      ...claimFilter,
      $or: [
        { executionLeaseId: null },
        { executionLeaseExpiresAt: { $lt: claimAt } },
      ],
    },
    {
      $set: {
        ...claimSet,
        executionLeaseId: leaseId,
        executionLeaseExpiresAt: new Date(
          Date.now() + EXECUTION_LEASE_MS,
        ).toISOString(),
        status: "running",
        startedAt: claimAt,
      },
      ...(claimPush ? { $push: claimPush } : {}),
    },
  );
  if (claimed.matchedCount === 0) {
    return false;
  }

  // Pinned capability: the run's OWN runner/workdir/session — nothing from the
  // caller. The message rides the resume slot the same way resumeRun carries its
  // answer.
  const runDir = `${board.repoPath}/.tosin4dev/runs/${runId}`;
  const outcomePath = `${runDir}/outcome.json`;
  const brief: RunnerBrief = {
    ticket,
    board,
    workDir: run.workDir,
    phase: run.phase,
    outcomePath,
    resume: { sessionId: run.executionSessionId, answer: message },
  };

  let child: ChildProcess | undefined;
  let runningChild: RunningChild | undefined;
  try {
    // Every write below carries the claimed lease id: a turn that lost its lease
    // can never write.
    await rm(outcomePath, { force: true });
    await writeFile(run.promptFile, buildPrompt(brief));

    const continueTurnId = new ObjectId().toString();
    const continueTurnPaths = turnPaths(runDir, continueTurnId);
    const continueTurn: RunTurn = {
      v: 1,
      id: continueTurnId,
      index: run.turns?.length ?? 0,
      at: now(),
      kind: "continue",
      outcome: null,
      stdoutFile: continueTurnPaths.stdoutFile,
      stderrFile: continueTurnPaths.stderrFile,
    };
    await mkdir(continueTurnPaths.turnDir, { recursive: true });
    await writeFile(continueTurn.stdoutFile, "");
    await writeFile(continueTurn.stderrFile, "");

    const command = adapters[run.runner].buildCommand(brief, run.promptFile);
    const spawnedChild = spawn(command.cmd[0], command.cmd.slice(1), {
      cwd: run.workDir,
      env: {
        ...process.env,
        ...command.env,
        T4D_OUTCOME_PATH: outcomePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawnedChild;
    runningChild = {
      stdout: drainStream(
        spawnedChild.stdout,
        [run.logFile, continueTurn.stdoutFile],
        true,
      ),
      stderr: drainStream(
        spawnedChild.stderr,
        [run.stderrFile ?? run.logFile, continueTurn.stderrFile],
        false,
      ),
      exited: settledExit(spawnedChild),
    };
    void Promise.all([
      runningChild.stdout,
      runningChild.stderr,
      runningChild.exited,
    ]).catch(() => undefined);
    await waitForSpawn(spawnedChild);

    const runStarted = await runs.updateOne(
      {
        _id: new ObjectId(runId),
        status: "running",
        executionLeaseId: leaseId,
      },
      {
        $set: { pid: spawnedChild.pid, awaitingQuestion: null },
      },
    );
    if (runStarted.matchedCount === 0) {
      throw new ServerResultError("conflict", "run left running");
    }

    await afterRunStarted?.();

    // Pushed LAST, for the same reason as resumeRun's resume turn: a row written
    // before a throw is a turn nothing will ever close. Carries the lease id so a
    // turn that lost its claim can still never write.
    const turnRecorded = await runs.updateOne(
      {
        _id: new ObjectId(runId),
        status: "running",
        executionLeaseId: leaseId,
      },
      { $push: { turns: { $each: [continueTurn], $slice: -TURN_CAP } } },
    );
    if (turnRecorded.matchedCount === 0) {
      throw new ServerResultError("conflict", "run left running");
    }

    void monitorContinue(
      runningChild,
      runId,
      run,
      board,
      runDir,
      leaseId,
      continueTurnId,
    ).catch((error) =>
      console.error(`Continue monitor failed for run ${runId}:`, error),
    );
  } catch {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await runningChild?.exited.catch(() => undefined);
    }
    throw new ServerResultError("spawn_failed", "run could not be continued");
  }
  return true;
}

export async function continueExecution(
  runId: string,
  message: string,
): Promise<void> {
  const database = await db();
  const runs = database.collection<RunDoc>("runs");
  const run = await runs.findOne({ _id: new ObjectId(runId) });
  if (!run || run.status !== "awaiting_input") {
    throw new ServerResultError("conflict", "run is not awaiting input");
  }
  if (!run.executionSessionId) {
    throw new ServerResultError(
      "conflict",
      "run has no captured session to continue",
    );
  }

  const rawBoard = await database.collection<BoardDoc>("boards").findOne({
    _id: new ObjectId(run.boardId),
  });
  if (!rawBoard) {
    throw new ServerResultError("not_found", `board not found: ${run.boardId}`);
  }
  const board = BoardSchema.parse(rawBoard);
  const rawTicket = await database.collection<TicketDoc>("tickets").findOne({
    _id: new ObjectId(run.ticketId),
  });
  if (!rawTicket) {
    throw new ServerResultError(
      "not_found",
      `ticket not found: ${run.ticketId}`,
    );
  }
  const ticket = TicketSchema.parse(rawTicket);
  if (ticket.status !== "needs_input" || ticket.activeRunId !== runId) {
    throw new ServerResultError(
      "conflict",
      "ticket is not parked on this run",
    );
  }
  const pendingFeedback = run.pendingFixFeedback;
  const resumedMessage = pendingFeedback
    ? `${message}\n\n${pendingFeedback.message}`
    : message;

  // The message must ride the claiming update, exactly as resumeRun carries its
  // answer: a second write could fail after status flips to running, losing the
  // human's text with no safe retry. Pin the exact row — see resumeRun for why
  // `{$type:"null"}` and the `at` identity term are both required.
  const priorExchanges = run.exchanges ?? [];
  let openIndex = -1;
  priorExchanges.forEach((exchange, index) => {
    if (exchange.answer === null) openIndex = index;
  });
  const openRow = openIndex >= 0 ? priorExchanges[openIndex] : null;
  const claimFilter: Record<string, unknown> = {
    _id: new ObjectId(runId),
    status: "awaiting_input",
  };
  if (openIndex >= 0 && openRow) {
    claimFilter[`exchanges.${openIndex}.answer`] = { $type: "null" };
    claimFilter[`exchanges.${openIndex}.at`] = openRow.at;
  } else {
    // No open row in our snapshot. Pin both that absence and the parked question,
    // exactly as resumeRun does, so a concurrent park cannot slip an open row in
    // between our read and this claim — which would leave two open rows.
    claimFilter.exchanges = { $not: { $elemMatch: { answer: null } } };
    claimFilter.awaitingQuestion = run.awaitingQuestion ?? null;
  }
  const answerAt = now();
  const claimSet: Record<string, unknown> = {
    ...(openIndex >= 0
      ? {
          [`exchanges.${openIndex}.answer`]: message,
          [`exchanges.${openIndex}.answeredAt`]: answerAt,
        }
      : {}),
  };
  const claimPush: PushOperator<RunDoc> | undefined =
    openIndex === -1
      ? {
          exchanges: {
            $each: [
              {
                v: 1 as const,
                at: answerAt,
                question: questionOrFallback(
                  run.awaitingQuestion,
                  "(continued execution)",
                ),
                handoff: null,
                answer: message,
                answeredAt: answerAt,
              },
            ],
            $slice: -EXCHANGE_CAP,
          },
        }
      : undefined;

  const leaseId = new ObjectId().toString();
  let sent: boolean;
  try {
    sent = await sendContinueTurn({
      database,
      run,
      board,
      ticket,
      runId,
      message: resumedMessage,
      leaseId,
      claimFilter: claimFilter as Filter<RunDoc>,
      claimSet,
      claimPush,
      afterRunStarted: async () => {
        const at = now();
        const to = transition("needs_input", "provide_input");
        const ticketStarted = await database
          .collection<TicketDoc>("tickets")
          .updateOne(
            {
              _id: new ObjectId(run.ticketId),
              status: "needs_input",
              activeRunId: runId,
            },
            {
              $set: { status: to, updatedAt: at },
              $push: pushActivity("run", "continued execution", at),
            },
          );
        if (ticketStarted.matchedCount === 0) {
          throw new ServerResultError(
            "conflict",
            "ticket is no longer awaiting input",
          );
        }
      },
    });
  } catch {
    // Only a spawn failure (or a mid-send throw) lands here — a lost claim
    // returns false instead. Release the lease and re-park via the existing
    // resume compensation.
    try {
      await runs.updateOne(
        { _id: new ObjectId(runId), executionLeaseId: leaseId },
        { $set: { executionLeaseId: null, executionLeaseExpiresAt: null } },
      );
      await restoreParkedResume(database, run, runId, run.awaitingQuestion);
    } catch (compensationError) {
      console.error(
        `Failed to restore parked run ${runId} after spawn failure:`,
        compensationError,
      );
    }
    throw new ServerResultError("spawn_failed", "run could not be continued");
  }
  // The claim missed: the run was terminalized or a newer turn owns the lease
  // between our snapshot and this claim. Nothing was claimed and nothing was
  // written, so no compensation runs — report the lost race as a conflict, the
  // same code the old inline claim threw.
  if (!sent) {
    throw new ServerResultError("conflict", "run is already executing");
  }
  if (pendingFeedback) {
    await recordFixDelivery(
      runId,
      pendingFeedback.signature,
      pendingFeedback.attempts,
      pendingFeedback.signature,
    );
  }
}


export async function dispatchRun(
  rawTicketId: string,
  rawPhase: Phase,
): Promise<{ runId: string }> {
  await bootRecoveryOnce();
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
  if (phase === "execute") {
    // Intentional snapshot before the CAS claim: no lock is taken, so a dependency
    // changing or being archived in the tiny gap is tolerated for this low-stakes run.
    await assertDependenciesMet(ticket, ticketCollection);
  }

  const rawBoard = await database.collection<BoardDoc>("boards").findOne({
    _id: new ObjectId(ticket.boardId),
  });
  if (!rawBoard) {
    throw new ServerResultError("not_found", `board not found: ${ticket.boardId}`);
  }
  const board = BoardSchema.parse(rawBoard);

  // A board with no acceptance checks degrades verification to "a commit
  // appeared" (verdictFrom's no-checks branch), which is the exact claim this
  // app exists to be better than. Refuse before anything is claimed or spawned.
  // spec_draft is exempt: it is read-only and produces no commit to verify.
  if (phase !== "spec_draft" && board.checks.length === 0) {
    throw new ServerResultError(
      "no_acceptance_checks",
      `board "${board.slug}" has no acceptance checks — add at least one before dispatching`,
    );
  }
  // Publishing is the last step of any run that reaches a passed verdict, and
  // the publish block runs for every phase but spec_draft — including
  // review_fix. The preflight must cover exactly that same surface, so it is
  // gated on the same `phase !== "spec_draft"` the checks guard above uses: a
  // broken token discovered after twenty minutes of agent work is the worst
  // available ordering, and review_fix pays the same twenty minutes.
  if (phase !== "spec_draft") {
    await preflightPublish(board.repoPath);
  }
  const runId = new ObjectId().toString();
  const paths = runPaths(board, runId, phase);
  // Turn 0: the dispatch turn. Id is an ObjectId so it is unique within the
  // run and sorts by creation order. Persisted with the run so the record and
  // its (empty) per-turn files exist before the first byte is drained.
  const dispatchTurnId = new ObjectId().toString();
  const dispatchTurnPaths = turnPaths(paths.runDir, dispatchTurnId);
  const dispatchTurn: RunTurn = {
    v: 1,
    id: dispatchTurnId,
    index: 0,
    at: now(),
    kind: "dispatch",
    outcome: null,
    stdoutFile: dispatchTurnPaths.stdoutFile,
    stderrFile: dispatchTurnPaths.stderrFile,
  };
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
    stderrFile: paths.stderrFile,
    pid: null,
    exitCode: null,
    summary: null,
    branch: null,
    baseSha: null,
    verdict: null,
    failureKind: null,
    fixAttempts: 0,
    lastFixSignature: null,
    pendingFixFeedback: null,
    prUrl: null,
    executionSessionId: null,
    executionLeaseId: null,
    executionLeaseExpiresAt: null,
    parkedBy: "question" as const,
    awaitingQuestion: null,
    exchanges: [],
    turns: [dispatchTurn],
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
    await recordSetupFailure(
      runId,
      ticketId,
      policy.requiredStatus,
      dispatchTurnId,
    );
    throw error;
  }

  let worktreeCreated = false;
  let runBranch: string | null = null;
  let child: ChildProcess | undefined;
  let runningChild: RunningChild | undefined;
  try {
    await mkdir(paths.runDir, { recursive: true });
    await mkdir(dispatchTurnPaths.turnDir, { recursive: true });
    await writeFile(dispatchTurn.stdoutFile, "");
    await writeFile(dispatchTurn.stderrFile, "");
    if (phase !== "spec_draft") {
      await mkdir(`${board.repoPath}/.tosin4dev/worktrees`, { recursive: true });
      const created = await createRunBranch(
        board.repoPath,
        paths.workDir,
        board.defaultBaseBranch,
        runId,
      );
      runBranch = created.branch;
      worktreeCreated = true;
      await database.collection<RunDoc>("runs").updateOne(
        { _id: new ObjectId(runId) },
        { $set: { branch: created.branch, baseSha: created.baseSha } },
      );
    }

    const brief: RunnerBrief = {
      ticket,
      board,
      workDir: paths.workDir,
      phase,
    };
    await writeFile(paths.promptFile, buildPrompt(brief));
    await writeFile(paths.logFile, "");
    await writeFile(paths.stderrFile, "");
    const command = adapters[ticket.runner].buildCommand(
      brief,
      paths.promptFile,
    );
    const spawnedChild = spawn(command.cmd[0], command.cmd.slice(1), {
      cwd: paths.workDir,
      env: {
        ...process.env,
        ...command.env,
        T4D_OUTCOME_PATH: `${paths.runDir}/outcome.json`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawnedChild;
    runningChild = {
      stdout: drainStream(
        spawnedChild.stdout,
        [paths.logFile, dispatchTurn.stdoutFile],
        true,
      ),
      stderr: drainStream(
        spawnedChild.stderr,
        [paths.stderrFile, dispatchTurn.stderrFile],
        false,
      ),
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
      paths.stderrFile,
      board,
      paths.runDir,
      dispatchTurnId,
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
    await recordSetupFailure(
      runId,
      ticketId,
      policy.requiredStatus,
      dispatchTurnId,
    );
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

export function bootRecoveryOnce(): Promise<void> {
  if (!globalForBoot.__tosin4devRecovered) {
    globalForBoot.__tosin4devRecovered = recoverOrphans().catch((error) => {
      globalForBoot.__tosin4devRecovered = undefined;
      throw error;
    });
  }
  return globalForBoot.__tosin4devRecovered;
}

export async function recoverOrphans(): Promise<void> {
  const database = await db();
  const runCollection = database.collection<RunDoc>("runs");
  const staleRuns = await runCollection
    .find({ status: { $in: ["queued", "running", "verifying"] } })
    .toArray();

  for (const run of staleRuns) {
    if (isProcessAlive(run.pid)) continue;
    const at = now();
    // A `verifying` run is mid-verification OR mid-publish: the run stays
    // `verifying` while it pushes its branch and opens its PR, so a restart
    // in that window can orphan a run whose work already passed. The evidence
    // row records what the verification actually decided. A passed row means
    // the run is NOT a failure — the process died after verifying, while
    // publishing — so recovery must not write verdict failed over it and block
    // the ticket. The PR itself may already exist on the remote with its url
    // recorded nowhere (the process died before the $set that writes prUrl),
    // which is why the notification names the branch. Failure here is also
    // fine: a missing row, or one that did not pass, is an ordinary orphan.
    let passedEvidence = false;
    if (run.status === "verifying") {
      const evidenceRow = await database
        .collection<Evidence>("evidence")
        .findOne({ runId: run._id.toString(), verdict: "passed" });
      if (evidenceRow) {
        // Parse the row at the boundary: the verdict gates which terminal write
        // happens, and an untyped row would let a renamed field silently fall
        // through to the failure path.
        passedEvidence =
          EvidenceSchema.pick({ verdict: true }).parse(evidenceRow).verdict ===
          "passed";
      }
    }
    const orphaned: Record<string, unknown> = passedEvidence
      ? {
          status: "succeeded",
          exitCode: null,
          verdict: "passed",
          failureKind: null,
          summary: "Run orphaned during publish after verification passed",
          finishedAt: at,
        }
      : {
          status: "failed",
          exitCode: null,
          failureKind:
            run.status === "verifying" ? "verification_failed" : "runner_exit",
          verdict: run.status === "verifying" ? "failed" : null,
          summary: "Run orphaned after supervisor restart",
          finishedAt: at,
        };
    // A continue turn's lease is a claim on a live process. When that process is
    // dead AND the lease has run out, clear the lease so the parked run can be
    // claimed again. Runs that hold no lease are untouched.
    if (
      run.executionLeaseExpiresAt !== null &&
      run.executionLeaseExpiresAt < at
    ) {
      orphaned.executionLeaseId = null;
      orphaned.executionLeaseExpiresAt = null;
    }
    const failed = await runCollection.updateOne(
      { _id: run._id, status: { $in: ["queued", "running", "verifying"] } },
      { $set: orphaned },
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

    if (passedEvidence) {
      // The run verified and the ticket's work is on a real branch — the draft
      // PR may already be open on the remote. The ticket moves to review_ready,
      // never blocked: verified work must not be reported as broken. prUrl
      // cannot be recovered (the process died before it was written), so the
      // notification names the branch as the recovery path.
      const reviewReady = await ticketCollection.updateOne(
        {
          _id: new ObjectId(run.ticketId),
          activeRunId: run._id.toString(),
          status: "running",
        },
        {
          $set: { activeRunId: null, status: "review_ready", updatedAt: at },
          $push: pushActivity(
            "run",
            "orphaned during publish; verification passed",
            at,
          ),
        },
      );
      if (reviewReady.matchedCount === 0) {
        await ticketCollection.updateOne(
          { _id: new ObjectId(run.ticketId), activeRunId: run._id.toString() },
          { $set: { activeRunId: null, updatedAt: at } },
        );
      }
      const branch = run.branch ?? "the run branch";
      await notify(
        `⚠️ orphaned during publish: ${await ticketLabel(database, run.ticketId)} — verification passed; an open PR may exist on ${branch}. Log: ${run.logFile}${run.stderrFile ? ` (stderr: ${run.stderrFile})` : ""}`,
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
