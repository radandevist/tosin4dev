import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  ChatMessageSchema,
  ChatTurnStatus,
  ObjectIdString,
} from "../domain/schemas";
import {
  createChatSessionCore,
  createConsultationSessionCore,
  forkConsultationSessionCore,
  getChatSessionCore,
  proposeBundleFromChatCore,
  sendChatMessageCore,
} from "./chat.server";
import { authenticatedBoundary } from "./authBoundary.server";
import type { ServerResult } from "./result";

const timestamp = z.string().datetime();

// Client-facing chat session. Explicitly omits server-owned bookkeeping
// (pid, logFile, pendingKind, pendingUserMessageAt). `.strict()` is a real
// contract — toDTO builds this by explicit pick, never a spread (slice-B lesson).
export const ChatSessionDTOSchema = z
  .object({
    _id: ObjectIdString,
    boardId: ObjectIdString,
    kind: z.enum(["brainstorm", "consultation"]),
    runId: ObjectIdString.nullable(),
    provider: z.enum(["claude", "codex"]),
    sessionId: z.string().nullable(),
    status: z.enum(["active", "bundle_locked", "abandoned"]),
    turnStatus: ChatTurnStatus,
    turnError: z.string().nullable(),
    messages: z.array(ChatMessageSchema),
    bundleId: ObjectIdString.nullable(),
    forkedFromSessionId: ObjectIdString.nullable(),
    forkedAtMessageCount: z.number().int().nonnegative().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type ChatSessionDTO = z.infer<typeof ChatSessionDTOSchema>;

export const CreateChatSessionInputSchema = z
  .object({
    boardId: ObjectIdString,
    provider: z.enum(["claude", "codex"]).optional(),
  })
  .strict();
export type CreateChatSessionInput = z.infer<
  typeof CreateChatSessionInputSchema
>;

export const CreateConsultationSessionInputSchema = z
  .object({
    runId: ObjectIdString,
    provider: z.enum(["claude", "codex"]).optional(),
  })
  .strict();
export type CreateConsultationSessionInput = z.infer<
  typeof CreateConsultationSessionInputSchema
>;

export const ChatSessionRefSchema = z
  .object({ sessionId: ObjectIdString })
  .strict();
export type ChatSessionRef = z.infer<typeof ChatSessionRefSchema>;

export const SendChatMessageInputSchema = z
  .object({ sessionId: ObjectIdString, text: z.string().min(1) })
  .strict();
export type SendChatMessageInput = z.infer<
  typeof SendChatMessageInputSchema
>;

export const ForkConsultationSessionInputSchema = z
  .object({
    sessionId: ObjectIdString,
    throughMessageCount: z.number().int().positive().optional(),
  })
  .strict();
export type ForkConsultationSessionInput = z.infer<
  typeof ForkConsultationSessionInputSchema
>;

const passthrough = (data: unknown): unknown => data;

export const createChatSession = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ id: string }>> =>
    authenticatedBoundary(CreateChatSessionInputSchema, data, createChatSessionCore),
  );

export const createConsultationSession = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ id: string }>> =>
    authenticatedBoundary(
      CreateConsultationSessionInputSchema,
      data,
      createConsultationSessionCore,
    ),
  );

export const forkConsultationSession = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ id: string }>> =>
    authenticatedBoundary(
      ForkConsultationSessionInputSchema,
      data,
      forkConsultationSessionCore,
    ),
  );

export const getChatSession = createServerFn({ method: "GET" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<ChatSessionDTO>> =>
    authenticatedBoundary(ChatSessionRefSchema, data, getChatSessionCore),
  );

export const sendChatMessage = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ ok: true }>> =>
    authenticatedBoundary(SendChatMessageInputSchema, data, sendChatMessageCore),
  );

export const proposeBundleFromChat = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ ok: true }>> =>
    authenticatedBoundary(ChatSessionRefSchema, data, proposeBundleFromChatCore),
  );
