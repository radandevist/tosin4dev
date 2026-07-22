import { z } from "zod";
import {
  ChatDraftSchema,
  ChatMessageSchema,
  ChatTurnStatus,
  ObjectIdString,
} from "../domain/schemas";

const timestamp = z.string().datetime();

// Client-facing chat session. Explicitly omits server-owned bookkeeping
// (pid, logFile, pendingKind, pendingUserMessageAt). `.strict()` is a real
// contract — toDTO builds this by explicit pick, never a spread (slice-B lesson).
export const ChatSessionDTOSchema = z
  .object({
    _id: ObjectIdString,
    boardId: ObjectIdString,
    provider: z.literal("claude"),
    sessionId: z.string().nullable(),
    status: z.enum(["active", "ticket_created", "abandoned"]),
    turnStatus: ChatTurnStatus,
    turnError: z.string().nullable(),
    messages: z.array(ChatMessageSchema),
    proposedSpec: ChatDraftSchema.nullable(),
    ticketId: ObjectIdString.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type ChatSessionDTO = z.infer<typeof ChatSessionDTOSchema>;
