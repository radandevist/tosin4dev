import type { WithId } from "mongodb";
import { ChatSessionSchema, type ChatSession } from "../domain/schemas";
import { ChatSessionDTOSchema, type ChatSessionDTO } from "./chat";
import { db, ObjectId } from "./db";
import { ServerResultError } from "./result";

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
  const doc = await coll.findOne({ _id: new ObjectId(input.sessionId) });
  if (!doc) {
    throw new ServerResultError(
      "not_found",
      `chat session not found: ${input.sessionId}`,
    );
  }
  return chatToDTO(doc);
}
