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

// The subset of a Spec a spec_draft runner is allowed to author. Approval
// fields are absent by construction, so a runner can never mark its own draft
// approved — that is the owner's gate and the only thing separating a draft
// from a dispatchable spec.
export const DraftedSpecSchema = z
  .object({
    intent: z.string().min(1),
    scope: z.string().default(""),
    nonGoals: z.string().default(""),
    acceptance: z.array(z.string().min(1)).default([]),
    links: z.array(z.string()).default([]),
    risk: Risk.default("low"),
  })
  .strict();
export type DraftedSpec = z.infer<typeof DraftedSpecSchema>;

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

// Bounds for a board's acceptance checks. `key` becomes a filename component
// (<runDir>/checks/<key>.log), so its length is capped well under the
// filesystem's 255-byte per-name limit; `timeoutMs` is a setTimeout delay, so
// it is capped below 2^31-1 where Node would silently clamp a larger value to
// 1ms instead of honoring the operator's choice.
export const MAX_CHECK_KEY_LENGTH = 64;
export const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
export const MAX_CHECK_TIMEOUT_MS = 1_800_000; // 30 minutes

// One acceptance command Tosin4dev runs itself to verify a ticket's work.
// `command` is an argv array executed with no shell (execFile semantics), so a
// board's stored check can never be a shell-injection vector. `key` is stable
// and referenced by Evidence; `timeoutMs` bounds a hung check.
export const BoardCheck = z.object({
  key: z.string().min(1).max(MAX_CHECK_KEY_LENGTH).regex(/^[a-z0-9_-]+$/),
  label: z.string().min(1),
  command: z.array(z.string().min(1)).min(1),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_CHECK_TIMEOUT_MS)
    .default(DEFAULT_CHECK_TIMEOUT_MS),
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

// The update boundary for a board's acceptance checks. `.strict()` keeps every
// other board field server-owned, and the superRefine enforces key uniqueness
// AT THE SCHEMA, not the UI: `key` is the identity Evidence files under
// `<runDir>/checks/<key>.log` are filed under, so two checks sharing one key
// would silently overwrite each other's log.
export const UpdateBoardChecksSchema = z
  .object({
    slug: z.string().min(1),
    checks: z.array(BoardCheck),
  })
  .strict()
  .superRefine(({ checks }, ctx) => {
    const seen = new Set<string>();
    for (const check of checks) {
      if (seen.has(check.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["checks", check.key],
          message: `duplicate check key: ${check.key}`,
        });
        continue;
      }
      seen.add(check.key);
    }
  });
export type UpdateBoardChecksInput = z.infer<typeof UpdateBoardChecksSchema>;

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

// A structured account of where a run stopped and what it needs decided.
// Enrichment, NOT a gate: a parked run with no handoff is still a valid
// needs_input, so nothing here may ever turn a needs_input into a failure.
export const HandoffBriefSchema = z
  .object({
    workDone: z.string().default(""),
    filesTouched: z.array(z.string()).default([]),
    commandsRun: z.array(z.string()).default([]),
    decision: z.string().default(""),
    options: z.array(z.string()).default([]),
    risk: z.string().default(""),
  })
  .strict();
export type HandoffBrief = z.infer<typeof HandoffBriefSchema>;

// One question→answer round trip on a run. `v` is the record version: this
// history is read by consultation context building and by later slices, so it
// must be able to evolve without silently reinterpreting stored rows.
// SUPERVISOR WRITE INVARIANT: if an open exchange exists, it is the last element
// with `answer === null`, and at most one exists at a time. Legacy history may
// be empty; this schema supplies its default but does not require a row.
export const InputExchangeSchema = z
  .object({
    v: z.literal(1),
    at: z.string().datetime(),
    question: z.string().min(1),
    handoff: HandoffBriefSchema.nullable().default(null),
    answer: z.string().nullable().default(null),
    answeredAt: z.string().datetime().nullable().default(null),
  })
  .strict();
export type InputExchange = z.infer<typeof InputExchangeSchema>;

// One dispatch-or-resume of a run. Each turn owns its own immutable id and its
// own per-turn stdout/stderr files (additive cache on top of the run-level
// logs, which keep receiving every byte). `index` is the turn's position in the
// run's turns array. Defaults keep pre-existing documents hydrating.
export const RunTurnSchema = z
  .object({
    v: z.literal(1),
    // Immutable, unique within the run. Generated as a serialized ObjectId so
    // turns are sortable by creation order without a separate timestamp sort.
    id: z.string().min(1),
    index: z.number().int().nonnegative(),
    at: z.string().datetime(),
    kind: z.enum(["dispatch", "resume", "continue"]),
    // The terminal outcome of this turn, resolved after the process exits.
    // null while the turn is running or for legacy dispatch/resume turns.
    outcome: z
      .enum(["continued", "needs_input", "completed", "failed"])
      .nullable()
      .default(null),
    stdoutFile: AbsolutePathString,
    stderrFile: AbsolutePathString,
  })
  .strict();
export type RunTurn = z.infer<typeof RunTurnSchema>;

// A verification failure that could not be delivered because the execution
// lease was unavailable or the send failed. It stays on the run until a later
// resumed turn actually accepts the feedback; only then does the fix-loop
// counter advance. Keeping the rendered message (rather than only its
// signature) makes the retry independent of ephemeral check-log files.
export const PendingFixFeedbackSchema = z
  .object({
    message: z.string().min(1),
    signature: z.string().min(1),
    attempts: z.number().int().min(0),
  })
  .strict();
export type PendingFixFeedback = z.infer<typeof PendingFixFeedbackSchema>;

export const RunSchema = z.object({
  ticketId: ObjectIdString,
  boardId: ObjectIdString,
  runner: RunnerName,
  phase: RunPhase,
  status: RunStatus,
  workDir: AbsolutePathString,
  promptFile: AbsolutePathString,
  logFile: AbsolutePathString,
  // stdout only, since v5. stderr goes to stderrFile so JSONL framing in
  // logFile is not torn by interleaved writes. null for runs created before
  // the split.
  stderrFile: AbsolutePathString.nullable().default(null),
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
  // How many times failing acceptance checks have been handed back to the
  // agent on this run. Bounded by MAX_FIX_ATTEMPTS.
  fixAttempts: z.number().int().min(0).default(0),
  // Signature of the failure last delivered to the agent. A repeat means the
  // agent saw this exact failure and did not fix it; delivering it again buys
  // nothing. null until the first delivery.
  lastFixSignature: z.string().nullable().default(null),
  // Feedback that was prepared but not sent because the execution session was
  // parked, leased by another turn, or failed to spawn. Cleared only after a
  // resumed send succeeds.
  pendingFixFeedback: PendingFixFeedbackSchema.nullable().default(null),
  // Draft PR opened for this run's verified branch. null until published.
  // HttpUrlString, not `.url()`: the file documents above that `.url()` alone
  // accepts javascript:/mailto:, and a run's prUrl is persisted from gh's
  // stdout, so it is exactly the untrusted-shape boundary it exists for.
  prUrl: HttpUrlString.nullable().default(null),
  // Provider conversation id captured from the runner's structured output, so
  // a later turn can resume the SAME session. null for legacy/uncaptured runs.
  executionSessionId: z.string().nullable().default(null),
  // Exclusive claim guarding a single human `continue` turn. Claimed atomically
  // before spawn; cleared on re-park. Every write of the continuing turn carries
  // executionLeaseId so a turn that lost its lease can never write.
  executionLeaseId: z.string().nullable().default(null),
  executionLeaseExpiresAt: z.string().datetime().nullable().default(null),
  // Which park path produced the current `awaiting_input` state. A run parked by
  // a `continued` turn has no real question and MUST NOT be answered through
  // resumeRun, which is fail-closed and would terminalize a healthy run.
  parkedBy: z.enum(["question", "continued"]).default("question"),
  // The question a `needs_input` run is parked on; null otherwise.
  awaitingQuestion: z.string().nullable().default(null),
  // Durable Q&A history. `awaitingQuestion` stays the denormalised OPEN
  // question (cleared on resume); this survives every round trip.
  exchanges: z.array(InputExchangeSchema).default([]),
  // One record per dispatch or resume of this run. Immutable, append-only.
  turns: z.array(RunTurnSchema).default([]),
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
  handoff: HandoffBriefSchema.nullable().default(null),
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
  // When this commit was verified. The head-SHA guard sorts the latest evidence
  // row by this, so it must be typed — an untyped sort key would be checked
  // only by the database, never by the schema.
  createdAt: z.string().datetime(),
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
  kind: z.enum(["brainstorm", "consultation"]).default("brainstorm"),
  runId: ObjectIdString.nullable().default(null),
  provider: z.enum(["claude", "codex"]).default("claude"),
  sessionId: z.string().nullable().default(null),
  status: z.enum(["active", "bundle_locked", "abandoned"]).default("active"),
  turnStatus: ChatTurnStatus.default("idle"),
  turnError: z.string().nullable().default(null),
  messages: z.array(ChatMessageSchema).default([]),
  bundleId: ObjectIdString.nullable().default(null),
  forkedFromSessionId: ObjectIdString.nullable().default(null),
  forkedAtMessageCount: z.number().int().nonnegative().nullable().default(null),
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
