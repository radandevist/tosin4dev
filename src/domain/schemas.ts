import { z } from "zod";

export const TicketType = z.enum([
  "research",
  "spec",
  "implement",
  "bugfix",
  "review",
]);
export const TicketStatus = z.enum([
  "inbox",
  "spec_review",
  "approved",
  "running",
  "blocked",
  "review_ready",
  "done",
  "archived",
]);
export const RunnerName = z.enum(["claude", "codex"]);
export const Risk = z.enum(["low", "medium", "high"]);

export const SpecSchema = z.object({
  intent: z.string().min(1),
  scope: z.string().default(""),
  nonGoals: z.string().default(""),
  acceptance: z.array(z.string()).default([]),
  links: z.array(z.string()).default([]),
  risk: Risk.default("low"),
  approvedAt: z.string().datetime().nullable().default(null),
});
export type Spec = z.infer<typeof SpecSchema>;

export const ActivityEntry = z.object({
  at: z.string().datetime(),
  kind: z.string(),
  message: z.string(),
});
export type Activity = z.infer<typeof ActivityEntry>;

export const TicketSchema = z.object({
  boardId: z.string(),
  seq: z.number().int().positive(),
  title: z.string().min(1),
  type: TicketType,
  status: TicketStatus,
  runner: RunnerName,
  spec: SpecSchema,
  activeRunId: z.string().nullable().default(null),
  prUrl: z.string().url().nullable().default(null),
  activity: z.array(ActivityEntry).default([]),
});
export type Ticket = z.infer<typeof TicketSchema>;

export const BoardSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  repoPath: z.string().min(1),
  defaultBaseBranch: z.string().min(1),
});
export type Board = z.infer<typeof BoardSchema>;

export const RunPhase = z.enum(["spec_draft", "execute", "review_fix"]);
export const RunStatus = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
]);

export const RunSchema = z.object({
  ticketId: z.string(),
  boardId: z.string(),
  runner: RunnerName,
  phase: RunPhase,
  status: RunStatus,
  workDir: z.string(),
  promptFile: z.string(),
  logFile: z.string(),
  exitCode: z.number().int().nullable().default(null),
  summary: z.string().nullable().default(null),
});
export type Run = z.infer<typeof RunSchema>;
