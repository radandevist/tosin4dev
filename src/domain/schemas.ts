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

// A serialized Mongo ObjectId: exactly 24 hex characters. Used wherever a
// document references another document by its stringified _id.
export const ObjectIdString = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "must be a 24-character hex ObjectId");

// Absolute host filesystem path. This module is browser-bound (imported by
// client code), so we cannot pull in Node's `path`. A small regex covers the
// POSIX form (/foo), Windows drive form (C:\foo or C:/foo), and Windows UNC
// form (\\server\share) without any platform-specific import.
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
export const AbsolutePathString = z
  .string()
  .min(1)
  .regex(ABSOLUTE_PATH, "must be an absolute host path");

// A PR link must be a real http(s) URL. `.url()` alone accepts mailto:,
// javascript:, etc., so we additionally pin the protocol.
export const HttpUrlString = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const { protocol } = new URL(value);
        return protocol === "http:" || protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "must be an http(s) URL" },
  );

// Persisted spec shape. Defaults are retained so stored documents (and the
// server that hydrates them) can rely on every field being present.
export const SpecSchema = z.object({
  intent: z.string().min(1),
  scope: z.string().default(""),
  nonGoals: z.string().default(""),
  acceptance: z.array(z.string()).default([]),
  links: z.array(z.string()).default([]),
  risk: Risk.default("low"),
  approvedAt: z.string().datetime().nullable().default(null),
  // Approval is a single-operator action: the only non-null value is "radan".
  // Server-owned like approvedAt — the input schemas below omit both, so a
  // client can neither set nor clear approval, only the server can.
  approvedBy: z.literal("radan").nullable().default(null),
});
export type Spec = z.infer<typeof SpecSchema>;

export const ActivityEntry = z.object({
  at: z.string().datetime(),
  kind: z.string(),
  message: z.string(),
});
export type Activity = z.infer<typeof ActivityEntry>;

// Persisted ticket shape. Server-owned fields (seq/status/activeRunId/prUrl/
// activity) keep defaults for hydration; client input uses the *Input schemas
// below, which never expose these.
export const TicketSchema = z.object({
  boardId: ObjectIdString,
  seq: z.number().int().positive(),
  title: z.string().min(1),
  type: TicketType,
  status: TicketStatus,
  runner: RunnerName,
  spec: SpecSchema,
  activeRunId: ObjectIdString.nullable().default(null),
  prUrl: HttpUrlString.nullable().default(null),
  activity: z.array(ActivityEntry).default([]),
});
export type Ticket = z.infer<typeof TicketSchema>;

// One acceptance command Tosin4dev runs itself to verify a ticket's work.
// `command` is an argv array executed with no shell (execFile semantics), so a
// board's stored check can never be a shell-injection vector. `key` is stable
// and referenced by Evidence; `timeoutMs` bounds a hung check.
export const BoardCheck = z.object({
  key: z.string().min(1).regex(/^[a-z0-9_-]+$/),
  label: z.string().min(1),
  command: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive().default(120_000),
});
export type BoardCheck = z.infer<typeof BoardCheck>;

export const BoardSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  repoPath: AbsolutePathString,
  defaultBaseBranch: z.string().min(1),
  checks: z.array(BoardCheck).default([]),
});
export type Board = z.infer<typeof BoardSchema>;

export const RunPhase = z.enum(["spec_draft", "execute", "review_fix"]);
export const RunStatus = z.enum([
  "queued",
  "running",
  "verifying",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
]);

export const RunSchema = z.object({
  ticketId: ObjectIdString,
  boardId: ObjectIdString,
  runner: RunnerName,
  phase: RunPhase,
  status: RunStatus,
  workDir: AbsolutePathString,
  promptFile: AbsolutePathString,
  logFile: AbsolutePathString,
  exitCode: z.number().int().nullable().default(null),
  summary: z.string().nullable().default(null),
  // Execution worktree branch + its base commit. spec_draft runs work in the
  // repo root with no branch, so both are null there.
  branch: z.string().nullable().default(null),
  baseSha: z.string().nullable().default(null),
  // Verification outcome, set during the `verifying` stage. null until verified.
  verdict: z.enum(["passed", "failed"]).nullable().default(null),
  // Distinguishes WHY a run failed: a nonzero runner exit vs. a runner that
  // exited 0 but produced no reachable commit / failed an acceptance check.
  failureKind: z
    .enum(["runner_exit", "no_commit", "verification_failed"])
    .nullable()
    .default(null),
});
export type Run = z.infer<typeof RunSchema>;

export const EvidenceCheck = z.object({
  key: z.string().min(1),
  command: z.array(z.string()),
  exitCode: z.number().int(),
  outputRef: z.string(),
  passedAt: z.string().datetime(),
});
export const EvidenceVerdict = z.enum(["passed", "failed"]);
export const EvidenceSchema = z.object({
  runId: ObjectIdString,
  ticketId: ObjectIdString,
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  commitRef: z.string().min(1),
  checks: z.array(EvidenceCheck).default([]),
  verdict: EvidenceVerdict,
});
export type Evidence = z.infer<typeof EvidenceSchema>;

// --- Client input schemas (consumed by Task 4) --------------------------
// These are the shapes the browser is allowed to submit. They are `.strict()`
// so a client cannot smuggle server-owned fields, and they intentionally drop
// the persisted defaults: an update must send every spec field explicitly, so
// a partial payload can never silently erase scope/nonGoals/etc. via defaults.

export const SpecInputSchema = z
  .object({
    intent: z.string().min(1),
    scope: z.string(),
    nonGoals: z.string(),
    acceptance: z.array(z.string()),
    links: z.array(z.string()),
    risk: Risk,
  })
  .strict();
export type SpecInput = z.infer<typeof SpecInputSchema>;

export const CreateTicketInputSchema = z
  .object({
    boardId: ObjectIdString,
    title: z.string().min(1),
    type: TicketType,
    runner: RunnerName,
    spec: SpecInputSchema,
  })
  .strict();
export type CreateTicketInput = z.infer<typeof CreateTicketInputSchema>;

export const UpdateSpecInputSchema = z
  .object({
    ticketId: ObjectIdString,
    spec: SpecInputSchema,
  })
  .strict();
export type UpdateSpecInput = z.infer<typeof UpdateSpecInputSchema>;

// Changing a ticket's runner is a targeted mutation: only the ticket id and
// the new runner cross the boundary. `.strict()` keeps every other field
// server-owned.
export const SetRunnerInputSchema = z
  .object({
    ticketId: ObjectIdString,
    runner: RunnerName,
  })
  .strict();
export type SetRunnerInput = z.infer<typeof SetRunnerInputSchema>;
