import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WithId } from "mongodb";
import {
  BoardSchema,
  ChatSessionSchema,
  type Board,
  type ChatSession,
} from "../domain/schemas";
import { ChatSessionDTOSchema, type ChatSessionDTO } from "./chat";
import { buildChatCommand } from "./chatCommand";
import {
  parseBundle,
  parseChatResult,
  validateBundleMembers,
} from "./chatResult";
import { db, ObjectId } from "./db";
import { ServerResultError } from "./result";
import { replaceDraftingBundle } from "./specBundles.server";
import {
  drainStream,
  settledExit,
  waitForSpawn,
} from "./supervisor.server";

type BoardDoc = Board & { createdAt: string; updatedAt: string };

export const STUCK_TURN_MS = 5 * 60 * 1000;

interface RunningTurn {
  stdout: Promise<string>;
  stderr: Promise<string>;
  exited: Promise<number>;
}

// Persisted chat session document: validated fields + server-owned bookkeeping.
export type ChatSessionDoc = ChatSession & {
  createdAt: string;
  updatedAt: string;
  pid: number | null;
  logFile: string | null;
  pendingKind: "message" | "draft" | null;
  pendingUserMessageAt: string | null;
};

export const now = () => new Date().toISOString();

export function chatSessions() {
  return db().then((d) => d.collection<ChatSessionDoc>("chatSessions"));
}

async function loadBoard(boardId: string): Promise<Board> {
  const database = await db();
  const raw = await database
    .collection<BoardDoc>("boards")
    .findOne({ _id: new ObjectId(boardId) });
  if (!raw) throw new ServerResultError("not_found", `board not found: ${boardId}`);
  return BoardSchema.parse(raw);
}

async function failTurn(sessionId: string, message: string): Promise<void> {
  const coll = await chatSessions();
  await coll.updateOne(
    { _id: new ObjectId(sessionId) },
    {
      $set: {
        turnStatus: "error",
        turnError: message,
        pendingKind: null,
        pendingUserMessageAt: null,
        pid: null,
        updatedAt: now(),
      },
    },
  );
}

async function monitorChatTurn(
  running: RunningTurn,
  sessionId: string,
  kind: "message" | "draft",
): Promise<void> {
  let stdout: string;
  let code: number;
  try {
    [stdout, , code] = await Promise.all([
      running.stdout,
      running.stderr,
      running.exited,
    ]);
  } catch {
    await failTurn(sessionId, "the assistant process errored");
    return;
  }
  if (code !== 0) {
    await failTurn(sessionId, `the assistant exited with code ${code}`);
    return;
  }
  const parsed = parseChatResult(stdout);
  if (!parsed) {
    await failTurn(sessionId, "the assistant returned no parseable reply");
    return;
  }
  const coll = await chatSessions();
  const at = now();
  const sidPatch = parsed.sessionId ? { sessionId: parsed.sessionId } : {};

  if (kind === "message") {
    await coll.updateOne(
      { _id: new ObjectId(sessionId) },
      {
        $set: {
          turnStatus: "idle",
          turnError: null,
          pendingKind: null,
          pendingUserMessageAt: null,
          pid: null,
          updatedAt: at,
          ...sidPatch,
        },
        $push: { messages: { role: "assistant", text: parsed.result, at } },
      },
    );
    return;
  }

  // kind === "draft": propose a SpecBundle.
  const proposal = parseBundle(parsed.result);
  if (!proposal) {
    await failTurn(sessionId, "the proposal was not valid JSON");
    return;
  }
  const invalid = validateBundleMembers(proposal.members);
  if (invalid) {
    await failTurn(sessionId, `the proposal is invalid: ${invalid}`);
    return;
  }
  // The draft branch has a wider pre-finalize DB surface than the message
  // branch (session re-load + bundle upsert). Fail closed: a transient DB throw
  // here becomes an immediate retryable error, not a ≤STUCK_TURN_MS stuck turn.
  try {
    const session = await coll.findOne({ _id: new ObjectId(sessionId) });
    if (!session) {
      await failTurn(sessionId, "session vanished mid-turn");
      return;
    }
    const bundleId = await replaceDraftingBundle(
      sessionId,
      session.boardId,
      proposal,
    );
    await coll.updateOne(
      { _id: new ObjectId(sessionId) },
      {
        $set: {
          turnStatus: "idle",
          turnError: null,
          pendingKind: null,
          pendingUserMessageAt: null,
          pid: null,
          bundleId,
          updatedAt: at,
          ...sidPatch,
        },
      },
    );
  } catch {
    await failTurn(sessionId, "could not save the proposed bundle");
  }
}

// Claim a pending turn (throws on conflict/not-found BEFORE any side effect),
// then spawn the assistant. Once claimed, all execution failures resolve into
// turnStatus:"error" (retryable) rather than throwing — the poll surfaces it.
export async function startChatTurn(
  sessionId: string,
  text: string,
  kind: "message" | "draft",
): Promise<void> {
  const coll = await chatSessions();
  const doc = await coll.findOne({ _id: new ObjectId(sessionId) });
  if (!doc) {
    throw new ServerResultError("not_found", `chat session not found: ${sessionId}`);
  }
  if (doc.turnStatus === "pending") {
    throw new ServerResultError("conflict", "a turn is already in progress");
  }
  const board = await loadBoard(doc.boardId);

  const at = now();
  const logFile = `${board.repoPath}/.tosin4dev/chat/${sessionId}/turn.log`;

  const claim = await coll.updateOne(
    { _id: new ObjectId(sessionId), turnStatus: { $ne: "pending" } },
    {
      $set: {
        turnStatus: "pending",
        pendingKind: kind,
        pendingUserMessageAt: at,
        turnError: null,
        logFile,
        pid: null,
        updatedAt: at,
      },
      ...(kind === "message"
        ? { $push: { messages: { role: "user", text, at } } }
        : {}),
    },
  );
  if (claim.matchedCount === 0) {
    throw new ServerResultError("conflict", "a turn is already in progress");
  }
  await mkdir(dirname(logFile), { recursive: true });
  await writeFile(logFile, "");

  let child: ChildProcess | undefined;
  let running: RunningTurn | undefined;
  try {
    const cmd = buildChatCommand(text, doc.sessionId);
    const spawned = spawn(cmd[0], cmd.slice(1), {
      cwd: board.repoPath,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawned;
    running = {
      stdout: drainStream(spawned.stdout, logFile, true),
      stderr: drainStream(spawned.stderr, logFile, false),
      exited: settledExit(spawned),
    };
    void Promise.all([running.stdout, running.stderr, running.exited]).catch(
      () => undefined,
    );
    await waitForSpawn(spawned);
    await coll.updateOne(
      { _id: new ObjectId(sessionId) },
      { $set: { pid: spawned.pid ?? null } },
    );
    void monitorChatTurn(running, sessionId, kind).catch((error) =>
      console.error(`Chat monitor failed for session ${sessionId}:`, error),
    );
  } catch {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await running?.exited.catch(() => undefined);
    }
    await failTurn(sessionId, "could not start the assistant");
  }
}

// Light boot/stuck reconcile: a session left `pending` past STUCK_TURN_MS is
// failed so it becomes retryable. Called on read; full daemon recovery is out
// of scope (a stuck brainstorm is low-stakes).
export async function reconcileChatSession(
  doc: WithId<ChatSessionDoc>,
): Promise<void> {
  if (doc.turnStatus !== "pending") return;
  const stale =
    doc.pendingUserMessageAt !== null &&
    Date.now() - new Date(doc.pendingUserMessageAt).getTime() > STUCK_TURN_MS;
  if (!stale) return;
  // Reap only a genuinely stuck turn, and CAS-guard on turnStatus:"pending" so a
  // turn that completed between our read and this write is never clobbered. The
  // pid-liveness fast-reap was removed: a dead pid is the normal state while the
  // monitor is committing a successful turn, so it is not evidence of a stuck
  // turn. A crash-during-startup turn (pending, pid null forever) is still
  // recovered by the STUCK_TURN_MS backstop.
  const coll = await chatSessions();
  await coll.updateOne(
    { _id: new ObjectId(doc._id.toString()), turnStatus: "pending" },
    {
      $set: {
        turnStatus: "error",
        turnError: "the previous turn was interrupted",
        pendingKind: null,
        pendingUserMessageAt: null,
        pid: null,
        updatedAt: now(),
      },
    },
  );
}

// Explicit field-pick (never spread) so growth of ChatSessionDoc can never
// leak server bookkeeping through the `.strict()` DTO (slice-B regression).
export function chatToDTO(doc: WithId<ChatSessionDoc>): ChatSessionDTO {
  const validated = ChatSessionSchema.parse({
    boardId: doc.boardId,
    provider: doc.provider,
    sessionId: doc.sessionId,
    status: doc.status,
    turnStatus: doc.turnStatus,
    turnError: doc.turnError,
    messages: doc.messages,
    bundleId: doc.bundleId,
  });
  return ChatSessionDTOSchema.parse({
    _id: doc._id.toString(),
    boardId: validated.boardId,
    provider: validated.provider,
    sessionId: validated.sessionId,
    status: validated.status,
    turnStatus: validated.turnStatus,
    turnError: validated.turnError,
    messages: validated.messages,
    bundleId: validated.bundleId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}

export async function getChatSessionCore(input: {
  sessionId: string;
}): Promise<ChatSessionDTO> {
  const coll = await chatSessions();
  let doc = await coll.findOne({ _id: new ObjectId(input.sessionId) });
  if (!doc) {
    throw new ServerResultError(
      "not_found",
      `chat session not found: ${input.sessionId}`,
    );
  }
  if (doc.turnStatus === "pending") {
    await reconcileChatSession(doc);
    doc = (await coll.findOne({ _id: new ObjectId(input.sessionId) })) ?? doc;
  }
  return chatToDTO(doc);
}

export async function createChatSessionCore(input: {
  boardId: string;
}): Promise<{ id: string }> {
  await loadBoard(input.boardId); // validates the board exists
  const coll = await chatSessions();
  const at = now();
  const doc: ChatSessionDoc = {
    boardId: input.boardId,
    provider: "claude",
    sessionId: null,
    status: "active",
    turnStatus: "idle",
    turnError: null,
    messages: [],
    bundleId: null,
    createdAt: at,
    updatedAt: at,
    pid: null,
    logFile: null,
    pendingKind: null,
    pendingUserMessageAt: null,
  };
  const r = await coll.insertOne(doc);
  return { id: r.insertedId.toString() };
}

export async function sendChatMessageCore(input: {
  sessionId: string;
  text: string;
}): Promise<{ ok: true }> {
  await startChatTurn(input.sessionId, input.text, "message");
  return { ok: true };
}

const BUNDLE_INSTRUCTION = [
  "Based on our conversation, decompose the work into one or more tickets.",
  "Respond with ONLY a JSON object, no prose, matching exactly:",
  '{"rationale":string,"members":[{"localKey":string,',
  '"title":string,"type":"research"|"spec"|"implement"|"bugfix"|"review",',
  '"runner":"claude"|"codex",',
  '"spec":{"intent":string,"scope":string,"nonGoals":string,',
  '"acceptance":string[],"links":string[],"risk":"low"|"medium"|"high"},',
  '"dependsOn":string[]}]}',
  "localKey is a short unique id per ticket (t1,t2,…); dependsOn lists the",
  "localKeys this ticket depends on. No cycles. Prefer one ticket unless the",
  "work is genuinely separable.",
].join(" ");

export async function proposeBundleFromChatCore(input: {
  sessionId: string;
}): Promise<{ ok: true }> {
  const coll = await chatSessions();
  const doc = await coll.findOne({ _id: new ObjectId(input.sessionId) });
  if (!doc) {
    throw new ServerResultError(
      "not_found",
      `chat session not found: ${input.sessionId}`,
    );
  }
  if (doc.status !== "active") {
    throw new ServerResultError(
      "conflict",
      "this session has already locked its tickets",
    );
  }
  await startChatTurn(input.sessionId, BUNDLE_INSTRUCTION, "draft");
  return { ok: true };
}
