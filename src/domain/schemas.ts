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
  "needs_input",
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
  // Resolved dependency ticket ids (set at bundle lock; [] for standalone/legacy
  // tickets). Recorded and surfaced but NOT yet enforced at dispatch.
  dependsOn: z.array(ObjectIdString).default([]),
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
  "awaiting_input",
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
    .enum([
      "runner_exit",
      "no_commit",
      "verification_failed",
      "runner_reported_failure",
    ])
    .nullable()
    .default(null),
  // Provider conversation id captured from the runner's structured output, so
  // a later turn can resume the SAME session. null for legacy/uncaptured runs.
  executionSessionId: z.string().nullable().default(null),
  // The question a `needs_input` run is parked on; null otherwise.
  awaitingQuestion: z.string().nullable().default(null),
});
export type Run = z.infer<typeof RunSchema>;

// The structured outcome an execute/review_fix runner writes to
// <runDir>/outcome.json to declare a semantic result. Missing/invalid is
// treated as `failed` by the supervisor (fail-closed).
export const RunOutcomeSchema = z.object({
  outcome: z.enum(["completed", "needs_input", "failed"]),
  question: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
});
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

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

// --- Chat (brainstorm → draft → ticket) ---------------------------------
// A single chat session's provider conversation. Turn-based: each user turn
// is a batch `claude -p` call surfaced by polling. `turnStatus` is the
// session-level turn state; a failed turn is retryable (session stays usable).

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  at: z.string().datetime(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatTurnStatus = z.enum(["idle", "pending", "error"]);

// What draftSpecFromChat asks the model to emit — a superset of the ticket
// input minus server-owned fields. `.strict()` so a stray key fails closed.
export const ChatDraftSchema = z
  .object({
    title: z.string().min(1),
    type: TicketType,
    runner: RunnerName,
    spec: SpecInputSchema,
  })
  .strict();
export type ChatDraft = z.infer<typeof ChatDraftSchema>;

// Persisted chat session's validated fields. Defaults are retained so stored
// documents always hydrate with every field present (as with TicketSchema).
export const ChatSessionSchema = z.object({
  boardId: ObjectIdString,
  provider: z.literal("claude").default("claude"),
  sessionId: z.string().nullable().default(null),
  status: z.enum(["active", "bundle_locked", "abandoned"]).default("active"),
  turnStatus: ChatTurnStatus.default("idle"),
  turnError: z.string().nullable().default(null),
  messages: z.array(ChatMessageSchema).default([]),
  bundleId: ObjectIdString.nullable().default(null),
});
export type ChatSession = z.infer<typeof ChatSessionSchema>;

// --- SpecBundle (one brainstorm → many tickets) --------------------------
// A single proposed ticket within a bundle. `localKey` is the bundle-local
// dependency currency (unique within the bundle); it resolves to a real
// ticketId at lock. `.strict()` so a stray key fails closed.
export const BundleMemberSchema = z
  .object({
    localKey: z.string().min(1),
    title: z.string().min(1),
    type: TicketType,
    runner: RunnerName,
    spec: SpecInputSchema,
    dependsOn: z.array(z.string()).default([]),
  })
  .strict();
export type BundleMember = z.infer<typeof BundleMemberSchema>;

// What proposeBundle asks the model to emit: rationale + ordered members.
export const SpecBundleProposalSchema = z
  .object({
    rationale: z.string(),
    members: z.array(BundleMemberSchema).min(1),
  })
  .strict();
export type SpecBundleProposal = z.infer<typeof SpecBundleProposalSchema>;

// Persisted bundle. `members` array order IS the ticket order. `lockedTicketIds`
// (aligned to members order) is set at lock; null while drafting.
export const SpecBundleSchema = z.object({
  sessionId: ObjectIdString,
  boardId: ObjectIdString,
  status: z.enum(["drafting", "locked"]).default("drafting"),
  rationale: z.string().default(""),
  members: z.array(BundleMemberSchema).default([]),
  lockedTicketIds: z.array(ObjectIdString).nullable().default(null),
});
export type SpecBundle = z.infer<typeof SpecBundleSchema>;
