# Consultation Chat & Typed Input Exchanges — Design

Date: 2026-07-23
Slice ③ of the V2 chat-first pivot. Supersedes the parked write-up in
`Sessions/2026-07-23-night-shift-dep-dispatch-codex-chat` (vault).

Reviewed by GPT-5.6-Sol at xhigh (advisory, read-only) before writing. Sol
ratified the shape and supplied two of the refinements below; where this design
diverges from its advice, the divergence is called out inline.

## Problem

A run that hits a genuine decision writes `outcome: "needs_input"` with a
`question`, parks in `awaiting_input`, and the ticket moves to `needs_input`.
The human then gets a bare textarea containing one
line of context: `run.awaitingQuestion` (`RunsSection.tsx:212-254`).

Two gaps follow:

1. **No history.** `awaitingQuestion` holds only the *open* question and is
   cleared on resume (`supervisor.server.ts:807`). The answer is written into
   the next prompt and then exists nowhere structured. A run that parks three
   times leaves no record of the first two exchanges.
2. **No context to answer with.** The human must reconstruct what the run did
   from a raw log tail. There is no way to ask a second AI for help, because
   the only place the execution context lives is the live provider session —
   which we deliberately will not resume for conversation (see Non-goals).

## Shape

Three layers, built in order, each independently useful:

- **Layer 0 (precursor fix):** make run output trustworthy enough to build on.
- **Layer 1:** a typed, versioned `InputExchange` history on the run.
- **Layer 2:** a bounded, read-only **consultation chat** seeded from a
  `RunContext` package — a second AI that helps the human compose an answer but
  has no write path to the run.

The human gate is unchanged throughout. An answer reaches a run only via the
existing `provideInput` → `resumeRun` path, pressed by a person.

---

## Layer 0 — Output fidelity fixes (precursor)

Two defects in `drainStream` (`supervisor.server.ts:243-260`) that everything
downstream inherits. Both were found in Sol's review and confirmed against the
code; both are latent today, not yet observed in a real run.

### 0a. Head-truncation drops the session id

`drainStream` collects into a rolling buffer capped at `SUMMARY_OUTPUT_CAP`
(512 000 chars) by keeping the **last** 512 000:

```ts
if (collected.length > SUMMARY_OUTPUT_CAP) {
  collected = collected.slice(-SUMMARY_OUTPUT_CAP);
}
```

`parseSessionId(runDoc.runner, stdout)` (`:528`) runs on exactly that buffer.
Codex emits `{"type":"thread.started","thread_id":"…"}` as its **first** line, so
a codex run whose stdout exceeds 512 KB **silently loses its
`executionSessionId`** — and `resumeRun` hard-refuses a run with no captured
session (`supervisor.server.ts:719-724`). A long codex run that parks on a
question becomes permanently unresumable.

It fails safe (a refusal, not a wrong resume) but it strands real work.

**Scope, stated precisely: this fix rescues codex only.** An earlier draft of
this section claimed Claude's session id also rides a leading init object. It
does not, under the flags this repo actually uses. `claude -p --output-format
json` emits a **single JSON object** (`outcome.server.ts:5` says so, and
`claude.ts:23` sets the flag), and `parseSessionId` requires a complete
`JSON.parse` of a line beginning with `{`. When a claude run exceeds the buffer,
the head holds a prefix of that one object and the tail holds a suffix —
**neither parses**, so no window size fixes it. Verified by probe during review:
a 900 KB claude result yields `null` both before and after the head-window
change.

So a claude run over 512 KB stays unresumable. That is a **pre-existing defect,
not a regression**, and it is out of scope here — the honest fix is either to
capture the session id incrementally as it streams or to move claude to
`stream-json`, which is slice ④'s territory (and which slice ④ must therefore
not assume is already solved). Recorded as a known limitation with a comment at
the constants, and folded into the Layer 0 tests as an explicit non-claim rather
than left as a silent gap.

**Fix:** keep a head window and a tail window instead of tail-only.

```ts
const SUMMARY_HEAD_CAP = 64_000;
const SUMMARY_TAIL_CAP = 448_000; // head + tail = the existing 512_000 budget
const TRUNCATION_MARKER = "\n…[output truncated]…\n";
```

Fill `head` until it reaches `SUMMARY_HEAD_CAP`; everything after that goes into
a rolling `tail` capped at `SUMMARY_TAIL_CAP`. Return:

- `head` alone if the tail never started;
- `head + tail` if the tail never had to drop anything (the output is contiguous
  and under budget — no marker, so short runs are byte-identical to today);
- `head + TRUNCATION_MARKER + tail` once a drop occurred.

The marker is newline-delimited on **both** sides deliberately. Without the
leading newline, the marker would glue onto a partial head line; without the
trailing one, the tail's partial first line would glue onto the marker. Both
would manufacture a corrupt line. As specified, the only damage is one orphan
partial line, which every *line-based JSON* parser in the codebase already skips
(`parseSessionId`, `parseChatResult`, and `parseTurn` all iterate lines and
`continue` on a failed `JSON.parse`).

**`parseSummary` is the exception and must be handled.** It is the one consumer
that matches by regex rather than strict line-JSON (`supervisor.server.ts:320-337`):
it scans for `^(?:##\s*)?SUMMARY\s*$` and keeps the **last** match. Under the old
tail-only buffer a `SUMMARY` header early in a run was never in scope; bringing a
head window into scope means a long run that printed a bare `SUMMARY` in its
first 64 KB but emitted no final summary section would now report that early
scratch output as the run's result — into `RunDoc.summary`, the ticket UI, and
the review-ready notification, where it previously wrote `null`. Since summary
extraction cares about the END of the output, and the truncation marker is
exactly the head/tail delimiter, `parseSummary` must search only the portion
**after the last marker** when one is present. This is a regression the head
window introduces, so it ships in the same layer.

### 0b. stdout and stderr interleave in one file

Both drains append to the same `run.logFile` (`:794-795`, `:998-999`). For a
codex run that file is supposed to be JSONL; interleaved stderr writes tear
lines apart mid-object. Nothing parses the file today — only the in-memory
stdout buffer is parsed — but Layer 2 wants to excerpt the log, and slice ④
wants to tail it as framed JSONL. Splitting now is cheaper than splitting later.

**Fix:** `Run.logFile` keeps its meaning and becomes **stdout only**. Add
`Run.stderrFile: AbsolutePathString | null` (default `null`, so legacy runs
hydrate). `drainStream(stderr, …)` writes there.

**Do not regress the log viewer.** `logTailCore` (`runs.server.ts:97-109`)
currently shows the human everything, and errors usually arrive on stderr. It
must read `logFile` and, when `stderrFile` is set and non-empty, append a
clearly delimited stderr section:

```
──── stderr ────
<tail of stderrFile>
```

Byte budget is split between the two so `LogTailInputSchema.bytes` stays an
honest ceiling.

**Why this is a separate commit, not part of Layer 1.** It is a correctness fix
to existing behaviour with its own regression tests, and Layers 1–2 depend on
it. Landing it separately keeps the fix bisectable and reviewable on its own.

---

## Layer 1 — Typed, versioned input exchanges

Sol's refinement: make this a typed, versioned record, not generic activity
rendering. Activity entries are `{at, kind, message}` free text — fine for a
timeline, useless as a data source for Layer 2.

### Schema (`src/domain/schemas.ts`)

```ts
// A structured account of where a run stopped and what it needs decided.
// Enrichment, NOT a gate: a parked run with no handoff is still a valid
// needs_input. Never throw on a missing or malformed handoff.
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
// history is read by later slices and by consultation context building, so it
// must be able to evolve without silently reinterpreting stored rows.
export const InputExchangeSchema = z
  .object({
    v: z.literal(1),
    at: z.string().datetime(),
    question: z.string(),
    handoff: HandoffBriefSchema.nullable().default(null),
    answer: z.string().nullable().default(null),
    answeredAt: z.string().datetime().nullable().default(null),
  })
  .strict();
export type InputExchange = z.infer<typeof InputExchangeSchema>;
```

`RunSchema` gains `exchanges: z.array(InputExchangeSchema).default([])` and
`stderrFile: AbsolutePathString.nullable().default(null)`.

`RunOutcomeSchema` gains `handoff: HandoffBriefSchema.nullable().default(null)`.

**Fail-open on the handoff only.** The codebase's fail-closed posture governs
the *outcome* — a missing or invalid `outcome.json` is still a failure. The
handoff is advisory context; a runner that omits it or emits a malformed one
must not have its `needs_input` converted into a `failed`. Parse it with
`safeParse` and fall back to `null`.

**Scoped to `needs_input`.** The fail-open applies only when the outcome is
`needs_input`; any other outcome forces `handoff: null`. This keeps the hole
exactly as wide as its justification and buys a useful invariant:
**`handoff !== null` implies the run is parked.** Without the scoping, a
`completed` or `failed` outcome could carry a handoff, and downstream code that
reasonably reads `if (outcome.handoff)` as "this run is parked" would be wrong.

**Version the exchange record, and tolerate rows individually.** `v` is
`z.literal(1)` deliberately — widening it to `z.number()` would silently
reinterpret a future v2 row as v1, which is the failure the field exists to
prevent. The consequence is that `z.array(InputExchangeSchema)` rejects the
whole array on one bad row, so any **read** path must `safeParse` row by row and
drop failures rather than parsing the array as a unit. When v2 arrives it
becomes `z.discriminatedUnion("v", […])`, of which the current literal is the
one-member case. Wrapping the array in `.catch([])` is not acceptable: it would
render a run that was consulted three times as "no questions were ever asked",
which is a worse lie than a visible gap.

### Invariant

**The open exchange is the last element with `answer === null`.** At most one
open exchange exists at a time. `awaitingQuestion` remains the denormalised
open question (unchanged semantics, still cleared on resume) so nothing that
reads it today breaks.

### Writes

**On park** (`parkTicketNeedsInput`, `supervisor.server.ts:393-428`) — push the
exchange in the same `$set` update that sets `awaiting_input`:

```ts
$push: { exchanges: { v: 1, at, question, handoff, answer: null, answeredAt: null } }
```

**On resume** (`resumeRun`, `supervisor.server.ts:763-771`) — the existing
`awaiting_input → running` CAS claim already serialises concurrent answers, so
record the answer *in that same update*. It is then atomic with the claim, with
no second write to lose:

```ts
await runs.updateOne(
  { _id: new ObjectId(runId), status: "awaiting_input" },
  {
    $set: {
      status: "running",
      startedAt: now(),
      "exchanges.$[open].answer": answer,
      "exchanges.$[open].answeredAt": now(),
    },
  },
  { arrayFilters: [{ "open.answer": null }] },
);
```

Note for the implementer: a legacy run parked before this slice has
`exchanges: []`. MongoDB errors only when an `arrayFilters` identifier is
*unused* in the update document — matching **zero** elements is not an error, it
simply leaves the array untouched. So this same update is correct for legacy
parked runs, which continue to resume via `awaitingQuestion` with no history
recorded. Cover it with a test rather than a special case.

**On spawn-failure compensation** (`restoreParkedResume`,
`supervisor.server.ts:675-710`) — do **not** revert the recorded answer. The
human really did answer; erasing it loses information and would leave the
history lying. Instead push a **new open exchange carrying the same question**.
History then honestly reads: asked → answered → spawn failed → asked again, and
the "open = last with `answer === null`" invariant holds.

### Prompt (`src/runners/brief.ts`)

Extend the `needs_input` contract so runners emit the handoff:

```
{"outcome":"completed|needs_input|failed","question":"…","reason":"…","summary":"<=10 lines",
 "handoff":{"workDone":"…","filesTouched":[…],"commandsRun":[…],"decision":"…","options":[…],"risk":"…"}}
```

with an instruction that `handoff` is required when `outcome` is `needs_input`
and ignored otherwise. "Required" is a prompt-level expectation, not a parse
gate — see fail-open above.

### UI (`src/components/RunsSection.tsx`)

Render answered exchanges above the open question as a compact Q&A thread
(question, answer, timestamp). Render the open exchange's handoff — when
present — as a collapsible "What the run did" block above the answer textarea.
The existing textarea and Provide-input button are unchanged.

---

## Layer 2 — Consultation chat

A second AI the human can talk to while composing an answer. It reads a bounded
context package about the parked run. It cannot touch the run.

### The context gap, stated honestly

Sol's framing, which this design adopts: a session id is a **resume key**, and
a `logFile` is **forensic evidence of observable actions**. Neither is an export
of the model's effective context — no hidden reasoning, no prior prompt content,
no compaction state. A consultant reading the log knows what the run *did and
said*, not what it was *thinking*.

So the consultant is deliberately **not** given the log as its primary input.
It is given a purpose-built package, log excerpts last.

### `RunContextBuilder` (`src/server/runContext.server.ts`)

```ts
export async function buildRunContext(runId: string): Promise<{ text: string }>;
```

Assembles a **character-budgeted** package (`RUN_CONTEXT_CHAR_BUDGET = 48_000`,
≈12k tokens) in strict priority order. Later sections are dropped entirely when
the budget is exhausted — sections are never half-included:

1. **Locked spec** — ticket seq/title/intent/scope/nonGoals/acceptance.
   Always included; never dropped. If the spec alone exceeded the budget the
   package would be meaningless, so this section is exempt from the cap.
2. **Exchange history** — every `InputExchange`, newest first, so the freshest
   round trips survive truncation.
3. **Handoff brief** of the open exchange.
4. **Objective worktree facts** — `run.branch`, `run.baseSha`, plus
   `git status --porcelain` and `git log --oneline <baseSha>..HEAD` executed in
   `run.workDir`.
5. **Redacted log excerpt** — tail of `logFile`, then `stderrFile`, only if
   budget remains.

Git commands run via `execFile` with an argv array and **no shell**, matching
the existing `BoardCheck` execution rule (`schemas.ts:101-110`). A git failure
degrades that section to a one-line note; it never fails the build.

### Redaction

Both execution and chat inherit the full server env, so logs can contain
secrets. Piping a raw log into a chat transcript — which is persisted, and which
the human may later share — is a real leak path. This is the single control that
makes Layer 2 safe, so it is specified concretely.

`redactSecrets(text)` in `src/server/redact.ts`, applied to **every** section
(4 and 5 by necessity; 1–3 defensively, since a runner can echo a secret into
its own handoff):

- **Env-derived:** for each `process.env` key matching
  `/(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i` whose value is ≥ 8
  characters, replace every literal occurrence of that value with `[REDACTED]`.
  This catches the actual live secrets regardless of format.
- **Shape-derived:** `sk-[A-Za-z0-9_-]{16,}`, `gh[pousr]_[A-Za-z0-9]{20,}`,
  `AKIA[0-9A-Z]{16}`, `Bearer\s+[A-Za-z0-9._~+/-]{20,}`, and JWT-shaped
  `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`.

**Fail-closed:** if `redactSecrets` throws, the offending section is omitted
entirely rather than emitted raw.

### Session model (`src/domain/schemas.ts`)

`ChatSessionSchema` gains:

```ts
kind: z.enum(["brainstorm", "consultation"]).default("brainstorm"),
runId: ObjectIdString.nullable().default(null),
```

`createConsultationSessionCore({ runId })` requires the run to be in
`awaiting_input`, builds the context package, and seeds it as the session's
first message. Provider selection reuses the existing claude|codex choice.

### Read-only enforcement — and a divergence from Sol

Sol correctly flags that codex chat gets `-s read-only`
(`chatCommand.ts`) while **the claude chat path has no equivalent restriction
in this repo**. A consultation session on claude could, as things stand, write.

Sol recommended running the consultant read-only *in the parked worktree*. This
design **diverges**: a consultation session runs with `cwd` set to a dedicated
empty scratch directory (`<runDir>/consult/`), not the worktree.

Reasons: (a) it is provider-agnostic — it does not depend on a Claude CLI
sandbox flag whose exact semantics are unverified here, and guessing at a
safety flag is worse than not relying on one; (b) the context package *is* the
context, so worktree access buys little; (c) an empty cwd makes "it cannot
damage the run" true by construction rather than by configuration.

Codex additionally keeps `-s read-only`, so it is belt-and-braces there.

**Flip-point, and a task step:** confirm whether the installed Claude CLI
exposes a tool-restriction flag (`--allowedTools` / `--disallowedTools` or
equivalent) by checking `claude --help` on this machine. If it does, add it —
as a *verified* flag, not an assumed one. If it does not, the scratch cwd stands
alone and that fact is recorded in the spec. Reading the consultant into the
worktree remains available later if a concrete need appears.

### No write path

The consultation chat has **no** server function that touches runs or tickets.
The UI offers "Use as my answer", which copies the consultant's text into the
existing answer textarea. The human still presses **Provide input**, which still
calls `provideInput` → `resumeRun`. Verification semantics are untouched: only a
`completed` outcome may reach the reachable-commit + acceptance-check + Evidence
path, exactly as today.

### No session registry

`Run.executionSessionId` / `Run.logFile` and `ChatSession.sessionId` /
`ChatSession.runId` already own every pointer this needs. On standalone Mongo
with no transactions, a separate registry collection would duplicate mutable
pointers with nothing to keep the copies honest. Sol independently reached the
same conclusion.

---

## Testing

- **Unit — `drainStream`:** output under budget is byte-identical to input (no
  marker); output over budget retains the first line and the last line and
  contains the marker; a synthetic codex stream >512 KB still yields its
  `thread_id` through `parseSessionId`. This last one is the regression test for
  the actual defect.
- **Unit — `redactSecrets`:** each shape pattern; an env-derived secret planted
  in `process.env` is scrubbed from arbitrary text; a short env value (< 8
  chars, e.g. `KEY=abc`) does **not** trigger mass replacement of a common
  substring.
- **Unit — exchange invariant:** helpers that locate the open exchange; a
  history with zero, one, and several answered exchanges.
- **Unit — outcome parse:** `needs_input` with a valid handoff; with a
  malformed handoff (→ `handoff: null`, outcome still `needs_input`); with no
  handoff at all.
- **Unit — `buildRunContext` budgeting:** spec always present; sections dropped
  whole, never truncated mid-section; newest exchanges survive when history
  overflows.
- **Smoke (real Mongo):** a run parks → exchange pushed with `answer: null`;
  `provideInput` → the same exchange gains `answer` + `answeredAt` atomically
  with the claim; a forced spawn failure → a *new* open exchange with the same
  question and the prior answer preserved; two concurrent `provideInput` calls →
  exactly one wins (the CAS claim), the loser gets `conflict`.
- **Smoke — log split:** stdout goes to `logFile`, stderr to `stderrFile`,
  `logTailCore` surfaces both with the delimiter.
- **Smoke — consultation:** `createConsultationSession` on a parked run seeds
  context; on a non-parked run → `conflict`; the seeded context contains the
  spec and the question and does **not** contain a planted env secret.
- **Gate:** `bun run test && bun run typecheck && bun run build`.
  Test contention on standalone Mongo makes parallel runs noisy — verify any
  failure with `bunx vitest run --no-file-parallelism` before believing it.

## Non-goals

Resuming the live execution session for conversation (option (b) — deferred
until real Turn records, leases/idempotency, and Sol's listed safety gates
exist). Token streaming (slice ④). Auto-submitting a consultant's answer.
Multiple concurrent consultants. Consultant access to the worktree. A session
registry collection.

## Migration

All new fields are additive with defaults. **But a Zod default does not save a
legacy document on the read path, and an earlier draft of this section wrongly
claimed it did.**

`RunSchema.parse` is called **only from tests**. Every production read —
`listRunsCore`, `logTailCore`, `resumeRun` — goes straight from
`collection.find()/findOne()` to use, and `listRunsCore` hands the raw document
to `toDTO`. So `RunSchema`'s `.default(null)` / `.default([])` never execute
against stored data. A document written before a field existed has **no key at
all**; destructuring yields `undefined`; and a `.nullable()` (not `.optional()`)
DTO field rejects `undefined` with `invalid_type: Required`. Because `boundary`
converts that to `code:"internal"` and `useRuns` throws, one legacy run erases
the **entire** runs list for that ticket, not just its own row.

This was found in review only after it shipped in the `stderrFile` field, and
it applies identically to `exchanges`.

**Rule for every new persisted field surfaced through a DTO:** default it at the
**explicit pick** in `toDTO` — `stderrFile: doc.stderrFile ?? null`,
`exchanges: doc.exchanges ?? []` — not (only) in the domain schema. And test it
with a document whose key is **genuinely absent**, not one that sets the key to
`null`; a fixture that hardcodes the post-migration shape proves nothing about
the documents production will actually meet.

Given that rule: `Run.exchanges` → `[]`, `Run.stderrFile` → `null`,
`RunOutcome.handoff` → `null`, `ChatSession.kind` → `"brainstorm"`,
`ChatSession.runId` → `null`. Legacy parked runs have an empty `exchanges`
array and still answer through `awaitingQuestion` — the UI renders the open
question from `awaitingQuestion` whether or not a matching exchange exists, so
a run parked before this slice remains answerable. No data migration required,
provided the pick-level defaults are present.
