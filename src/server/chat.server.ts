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
import { parseChatResult, parseDraft } from "./chatResult";
import { db, ObjectId } from "./db";
import { ServerResultError } from "./result";
import { createTicketCore } from "./tickets.server";
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

  const draft = parseDraft(parsed.result);
  if (!draft) {
    await failTurn(sessionId, "the drafted spec was not valid JSON");
    return;
  }
  await coll.updateOne(
    { _id: new ObjectId(sessionId) },
    {
      $set: {
        turnStatus: "idle",
        turnError: null,
        pendingKind: null,
        pendingUserMessageAt: null,
        pid: null,
        proposedSpec: draft,
        updatedAt: at,
        ...sidPatch,
      },
    },
  );
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
    proposedSpec: doc.proposedSpec,
    ticketId: doc.ticketId,
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
    proposedSpec: validated.proposedSpec,
    ticketId: validated.ticketId,
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

// The instruction that turns brainstorm context into a machine-parseable draft.
const DRAFT_INSTRUCTION = [
  "Based on our conversation so far, produce ONE ticket spec.",
  "Respond with ONLY a JSON object, no prose, matching exactly:",
  '{"title":string,"type":"research"|"spec"|"implement"|"bugfix"|"review",',
  '"runner":"claude"|"codex",',
  '"spec":{"intent":string,"scope":string,"nonGoals":string,',
  '"acceptance":string[],"links":string[],"risk":"low"|"medium"|"high"}}',
].join(" ");

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
    proposedSpec: null,
    ticketId: null,
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

export async function draftSpecFromChatCore(input: {
  sessionId: string;
}): Promise<{ ok: true }> {
  await startChatTurn(input.sessionId, DRAFT_INSTRUCTION, "draft");
  return { ok: true };
}

export async function createTicketFromChatCore(input: {
  sessionId: string;
}): Promise<{ ticketId: string; seq: number }> {
  const coll = await chatSessions();
  const doc = await coll.findOne({ _id: new ObjectId(input.sessionId) });
  if (!doc) {
    throw new ServerResultError(
      "not_found",
      `chat session not found: ${input.sessionId}`,
    );
  }
  if (!doc.proposedSpec) {
    throw new ServerResultError(
      "conflict",
      "no drafted spec to create a ticket from",
    );
  }
  const created = await createTicketCore({
    boardId: doc.boardId,
    title: doc.proposedSpec.title,
    type: doc.proposedSpec.type,
    runner: doc.proposedSpec.runner,
    spec: doc.proposedSpec.spec,
  });
  await coll.updateOne(
    { _id: new ObjectId(input.sessionId) },
    {
      $set: {
        status: "ticket_created",
        ticketId: created.id,
        updatedAt: now(),
      },
    },
  );
  return { ticketId: created.id, seq: created.seq };
}
