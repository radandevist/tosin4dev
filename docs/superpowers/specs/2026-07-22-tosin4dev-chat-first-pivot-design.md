# Tosin4dev — Chat-First Pivot Design Spec (v2)

Date: 2026-07-22
Status: draft, awaiting user review
Supersedes/extends: `docs/superpowers/specs/2026-07-19-tosin4dev-design.md` (v1). v1 domain model, supervisor, runner adapters, and UI are the foundation this builds on.
Reviewed by: GPT-5.6-Sol — two architecture passes (2026-07-22), critique incorporated throughout.

## 1. Product (revised)

Tosin4dev is a local-first, single-user dev-orchestration console. The pivot reframes how a ticket is *born* and how "done" is *proven*.

Radan opens an **interactive chat session** with an AI coding agent (Claude Code or Codex) and talks through what he wants — the brainstorming + spec-building phase. The session distills into a **locked spec** that becomes one or more tickets. From the lock onward the ticket runs **autonomously**: every decision was frozen during spec-building, so the runner proceeds without asking — *unless* it genuinely needs a decision, in which case the ticket moves to **Needs Input** (or **Blocked** on failure) and Radan unblocks it via the chat panel or a ticket comment. Radan reviews only at the end, and only after Tosin4dev has **proven the work actually happened**.

### Core principle (Sol's bottom line)

> **Tosin4dev — not the provider CLI session — owns the durable event log, the workspace lifecycle, the semantic turn outcomes, and the verification contract.**

v1 treated the CLI process as the source of truth (exit code = outcome, in-memory PID tracking). v2 inverts this: the CLI is a stateless executor of a single turn; Tosin4dev owns all durable state.

## 2. What changes from v1 — and what's reused

| Concern | v1 | v2 |
|---|---|---|
| Spec authoring | Static form fields | Live interactive chat session → distilled spec JSON |
| Spec → ticket | 1 ticket per form | **SpecBundle**: one session → 1..N tickets, transactional lock |
| Runner integration | `claude -p` / `codex exec` for everything | **Two interfaces per provider**: conversation surface (chat) + batch executor (autonomous run) |
| "Done" | Exit code 0 | **Verification contract**: reachable named commit + acceptance checks run by orchestrator |
| "Blocked" | Any nonzero exit | Typed outcomes: `needs_input · permission_required · waiting_dependency · failed_retryable · failed_terminal · succeeded` |
| Process model | Server functions spawn + track PIDs in memory | **Durable worker/daemon** with an append-only event journal, leases, boot recovery |
| Handoff context | (n/a) | Spec + approved decision-ledger (normative); transcript non-normative, redacted, on-demand |

**Reused as-is or lightly adapted:** git-worktree isolation, `Bun.spawn` runner invocation, Discord notifications, board/ticket UI shell, Zod-at-boundaries + `mongodb` driver, react-query-kit data layer, `.tosin4dev/` runtime dir convention.

## 3. Architecture decisions (confirmed)

- **A — Chat engine = headless streaming, our own UI, asymmetric per provider.**
  - **Claude Code**: long-lived streaming session via the **Agent SDK streaming-input mode** (`includePartialMessages`), not reverse-engineering the raw stdin envelope. (CLI-only flags like `--verbose --include-partial-messages` must not leak into the SDK adapter contract.)
  - **Codex**: the **Codex App Server** (`initialize` → `thread`/`turn/start`) — *not* `codex exec`. `exec` is process-per-turn and cannot accept a mid-turn message.
  - Spec captured as structured JSON emitted on a final turn. Unblock = a **new** turn (`turn/start`), never `turn/steer` (steer only mutates an *active* turn).
- **B — Handoff = hybrid, precedence-ordered.** `SPEC.json` (binding) **>** **approved decision ledger** (versioned, approval-stamped; part of the ticket hash) **>** redacted transcript (`NON-NORMATIVE`, on-demand). Conflict forces `needs_input`, never silent reinterpretation.
- **C — Session ↔ ticket = 1:many via a transactional SpecBundle.** Stable local ticket keys, declared dependencies, split rationale, all-or-nothing lock; overlapping-scope siblings serialized unless independence proven.
- **D — Unblock = durable turn outcome + enqueue-new-turn.** A "waiting" ticket is not a process blocked on stdin. Each turn ends in a validated outcome; unblocking atomically records the answer and enqueues a **new** turn on the saved execution session, guarded by an idempotency key + a lease so two turns never run on one session concurrently.
- **E — Provider-session topology (Sol's #1 risk, now pinned).** The brainstorm session and the execution session are **separate provider conversations**:
  - **One brainstorm session per `ChatSession`** (scoped to the board repo cwd).
  - On lock, each ticket gets a **fresh execution session**, seeded only with the locked spec + approved ledger (never the raw brainstorm thread).
  - Subsequent Turns **resume that execution session in the same worktree cwd**. Because Claude sessions are `cwd`-sensitive local files, the worktree path is pinned per execution session; a cwd mismatch must fail loudly, not silently fork a new session.
  - "Open chat" from **Needs Input** opens the *execution* session, not the brainstorm one.
- **Verification = Medium.** Reachable **named** commit + acceptance criteria (mapped to board-configured commands) run **by Tosin4dev, not the runner**, captured green as `Evidence`. Only then → `review_ready`. (Independent verifier agent deferred.)
- **Layout = C.** Board is its own screen; opening/creating a chat navigates to a dedicated full-screen workspace (chat left, live SpecBundle split preview right); Lock returns to the board.

## 4. Decomposition & sequencing (build order)

Sol flagged too many coupled failure surfaces for one plan. This spec is the north star; it is delivered as **five sequenced sub-plans**, each with its own writing-plans plan. Contract-level detail for later steps is finalized in that step's own scoping, not front-loaded here.

1. **Provider contract spike** *(throwaway; unblocks steps 5)* — prove real Codex App Server + Claude Agent SDK behavior (see §12).
2. **Durable execution kernel** — Run/Turn/EventJournal, leases, boot recovery, typed outcomes, named worktree refs.
3. **Verification kernel** — per-board check config, safe command execution, reachable-named-commit rule, Evidence, `review_ready` gate.
4. **SpecBundle domain** — transactional lock, precedence/hashing, immutable revisions, dependency semantics, legacy migration.
5. **Chat adapters + UI** — one provider / one-ticket bundles first, then second provider, multi-ticket split, Needs Input, transcript consultation.

> **FIRST SLICE (chosen): steps 2 + 3 applied to existing v1 form-authored tickets.** One ticket → one durable Turn → named commit → one configured acceptance check → Evidence → `review_ready`, closing the false-success defect end-to-end *before* any chat complexity. The provider spike (step 1) can run in parallel or after; the kernel does not depend on it. Steps 4–5 (ChatSession, SpecBundle, adapters) are deferred to later sub-plans — the domain shapes in §6 for those are provisional targets, finalized when their step is planned.

## 5. Verification contract (Medium) — the first slice's heart

On a runner's self-reported completion, Tosin4dev — independently — must confirm:

1. **Reachable named commit**: the turn's work is committed to a **named ref** (a per-run branch, e.g. `tosin4dev/run/<runId>`), replacing v1's detached worktree (`git worktree add --detach`, `supervisor.server.ts:121`). A dirty tree or a commit only reachable from `HEAD@{detached}` is *not* acceptance.
2. **Acceptance checks**: each acceptance criterion maps to a command via a **per-board check config** (below), each run **by the orchestrator** inside the worktree, all green.
3. **Evidence captured**: named commit SHA + each check's command/exit/output stored in `Evidence`.

Only a `passed` verdict advances to `review_ready`. A failed check yields a typed outcome, never a silent "done".

### Per-board check config + command safety

```ts
// Board.checks (new): ordered acceptance-command definitions
checks: [{ key: string, label: string, command: string[] /* argv, no shell */, timeoutMs: number }]
// Ticket.spec.acceptance criteria reference check keys (or free text mapped at lock time).
```

Commands are stored/run as **argv arrays via `Bun.spawn` (no shell string interpolation)**, in the worktree cwd, with the run timeout and the existing runner sandbox policy. This is the command-safety contract Sol flagged as missing.

## 6. Domain model (v2 target)

New/changed collections. Fields unchanged from v1 are not repeated. **Steps-4/5 shapes (`ChatSession`, `SpecBundle`) are provisional** and finalized in their sub-plan; the **first slice implements only `Run`, `Turn`, `EventJournal`, `Evidence`, and the `Ticket`/`Board` additions needed for them.**

### Run (new — a ticket's execution lifecycle; a sequence of Turns)

```ts
{
  _id: ObjectId, ticketId: ObjectId, boardId: ObjectId,
  provider: "claude" | "codex",
  executionSessionId: string | null, // provider conversation for THIS run (topology §3E)
  worktree: { path: string, branch: string, baseSha: string }, // named branch, not detached
  status: "active" | "review_ready" | "blocked" | "done" | "cancelled",
  currentTurnId: ObjectId | null,
  createdAt: Date, updatedAt: Date
}
```

### Turn (new — one bounded, restart-safe unit; lifecycle and outcome are SEPARATE)

```ts
{
  _id: ObjectId, runId: ObjectId, ticketId: ObjectId,
  executionSessionId: string,
  cliVersion: string, protocolVersion: string,
  worktree: { path: string, branch: string, baseSha: string },
  specVersion: number, specHash: string,   // what this turn executes against
  attempt: number,
  lifecycle: "queued" | "leased" | "running" | "verifying" | "finished",
  outcome: null                              // set only when lifecycle = finished
    | "succeeded" | "needs_input" | "permission_required"
    | "waiting_dependency" | "failed_retryable" | "failed_terminal" | "cancelled",
  reason: { kind: string, question: string | null, detail: string | null } | null,
  lease: { holder: string, expiresAt: Date } | null,
  idempotencyKey: string,
  eventCursor: number,
  heartbeatAt: Date | null, timeoutAt: Date | null,
  startedAt: Date | null, finishedAt: Date | null
}
```

Ordering is explicit: `running → verifying → finished(succeeded)` on success; verification runs during `verifying`, before any `succeeded`.

### EventJournal (new — append-only source of truth, polymorphic owner)

```ts
{ _id, scope: "session" | "turn", sessionId: ObjectId | null, turnId: ObjectId | null,
  ticketId: ObjectId | null, seq: number, at: Date, type: string, payload: object }
```

`scope` lets drafting-chat events (which have a `sessionId` but no turn/ticket yet) and execution events share one append-only log — resolving the "journal requires turnId/ticketId before they exist" gap.

### Evidence (new — proof for the verification gate)

```ts
{ _id, turnId, ticketId, runId,
  commitSha: string, commitRef: string,     // named ref, reachable
  checks: [{ key: string, command: string[], exitCode: number, outputRef: string, passedAt: Date }],
  verdict: "passed" | "failed", createdAt: Date }
```

### Ticket (additions)

```ts
{
  // ...v1 fields...
  bundleId: ObjectId | null,       // null for legacy/first-slice form tickets
  localKey: string | null,         // stable within a bundle
  dependsOn: string[],             // sibling localKeys
  spec: { /* v1 fields */ version: number, hash: string },
  decisionLedger: [{ at: Date, decision: string, rejectedAlternatives: string[],
                     approvedBy: "radan" | null, approvedAt: Date | null }],
  transcriptRef: string | null,    // redacted, NON-NORMATIVE
  activeRunId: ObjectId | null
}
```

Legacy v1 tickets remain valid with `bundleId: null`. A ticket reaches its session only via its bundle (no direct `sessionId` field).

### ChatSession / SpecBundle (provisional — steps 4/5)

```ts
// ChatSession: _id, boardId, provider, brainstormSessionId, cliVersion, protocolVersion,
//   status: "active"|"locked"|"revised"|"abandoned", bundleId. (Drafting events → EventJournal scope:"session".)
// SpecBundle: _id, sessionId, boardId, status:"drafting"|"locked", rationale,
//   version: number, supersedesBundleId: ObjectId|null,   // immutable revisions; a post-lock
//                                                          // change mints a NEW bundle version
//   specHash (over member ticket specs at lock), lockedAt, ticketOrder: ObjectId[].
```

A post-lock spec change is a **new bundle version** (`supersedesBundleId` chain), so `specHash` never goes stale on a frozen bundle — resolving the "irreversible freeze vs `spec.version++`" contradiction.

## 7. Autonomous runner (execution)

Reuses v1 worktree isolation + `Bun.spawn`, wrapped by a **durable worker (daemon)** — not TanStack server functions holding long-lived PIDs. Execution uses the batch interface (`codex exec` / `claude -p`) in the worktree with the v1 sandbox policy. One turn = spawn → run to a validated typed outcome → persist outcome + events → exit; the process never blocks on stdin. **Lease + idempotency**: the daemon leases a queued turn; a stale lease is reclaimed after `expiresAt`; `recoverOrphans` is **wired into daemon startup** (the v1 gap at `supervisor.server.ts:472/:525`). `failed_retryable` auto-retries under a bounded policy (default 3), card shows "retrying n/N".

## 8. Lifecycle, persisted status & board columns

Board columns are **derived**, mapped from the ticket's persisted status + its active turn's outcome — the board must stop grouping by raw `ticket.status` (`TicketCard.tsx:37`). New/extended `TicketStatus` values: `drafting`, `ready`, `running`, `needs_input`, `blocked`, `review_ready`, `done` (extends v1 `src/domain/schemas.ts:10`).

```
Drafting → Ready → Running → Review Ready → Done
             │
             ├─▶ Needs Input   (turn outcome needs_input / permission_required)
             └─▶ Blocked       (failed_terminal / waiting_dependency; reason on card)
```

- **Needs Input ≠ Blocked** — question vs failure; different affordances.
- `failed_retryable` = auto-retry badge, no column.
- **`HUMAN_GATES` correction** (`src/domain/stateMachine.ts:8`): the symbol means "waits on a human *decision*". Add **`needs_input`** (and `permission_required`) to it — **not** `blocked`. `waiting_dependency` resumes mechanically; `failed_terminal` needs investigation, not a decision. (My earlier "add blocked" note was wrong.)
- **Spec lock gate**: AI proposes the SpecBundle; Radan edits + accepts/merges/reorders the split, then **Locks** (irreversible). Post-lock chat = a new bundle version, never a mutation of the running snapshot.

## 9. UI / Layout (Option C)

- **Board screen**: 7-column kanban; cards show ticket key, title, runtime badge, reason.
- **Chat workspace** (route): chat left (bubbles + tool-call cards + input), live SpecBundle split preview right (per-ticket cards, dependency arrows, "Lock all"). Lock → board.
- **Needs Input affordance**: "Open chat" (resumes the *execution* session as a new turn) or an inline **comment** box (same enqueue-a-turn operation).

## 10. Non-goals (v2)

No independent verifier agent yet (Medium only); no GitHub sync, auth/multi-user, cloud, mobile; no in-app diff/editor beyond links + evidence output; no cross-ticket auto-dispatch beyond dependency serialization; no Hermes adapter (seam only).

## 11. Migration from v1

Additive collections (`Run`, `Turn`, `EventJournal`, `Evidence`, later `ChatSession`/`SpecBundle`); extended `Ticket`/`Board`; `TicketStatus` extended; `HUMAN_GATES` gains `needs_input`/`permission_required`. v1 supervisor refactors into the durable daemon with `recoverOrphans` wired to startup. Worktrees move from `--detach` to a named per-run branch. Legacy form tickets keep working (`bundleId: null`) — and are exactly what the first slice runs on.

## 12. Provider contract spike — RESOLVED (2026-07-22)

Ran as slice A. Full evidence: `2026-07-22-provider-contract-spike-findings.md`. All items empirically confirmed on `codex-cli 0.144.6` + current Claude Agent SDK; two assumptions corrected. **Decisions A–E hold; no rework.**

- ✅ Codex App Server is **NDJSON over stdio** (`--listen stdio://` default; Unix socket / WebSocket also); needs the two-stage `initialize`→`initialized` handshake; **generate types via `codex app-server generate-ts`** (don't hand-write). Methods: `thread/start|resume`, `turn/start|steer|interrupt`; deltas via `item/agentMessage/delta`.
- ✅ `turn/steer` is **active-turn-only** (needs `expectedTurnId`; errors after `turn/completed`) — so the durable unblock is a fresh **`turn/start`** (Decision D confirmed). Wait for `turn/started` before steering (start-response can precede the notification).
- ✅ **Resolved (yes):** an App Server `thread_id` **is** accepted by `codex exec resume <id>` (sessions at `~/.codex/sessions/…/rollout-*-<id>.jsonl` + `sessions.db`). Chat→exec continuity is possible; §3E still chooses a fresh execution session by design.
- ✅ Claude Agent SDK: `query(AsyncGenerator<SDKUserMessage>)` + `includePartialMessages` → `StreamEvent`/`text_delta`. Build on the **SDK**, not raw CLI stdin.
- ✅ Claude sessions are **cwd-keyed local JSONL**; a cwd mismatch silently forks a new session → **pin `cwd` per execution session** (§3E). `SessionStore` only for cross-host (not needed here).
- ✅ **Auth corrected:** both providers **inherit the existing login** (`~/.codex/auth.json` ChatGPT; `~/.claude/.credentials.json`) — **no API key required**. The Agent SDK does **not** bundle a `claude` binary; it requires `claude` on `PATH`.
- ⚠️ **Corrected:** `codex exec resume` takes cwd/sandbox as **root-level** flags (`codex -C <dir> -s <policy> exec resume …`), not as subcommand flags — so config need not be reproduced exactly.

## 13. Key risks & mitigations

Provider API drift → pin CLI+protocol per session, explicit migration. Transcript re-litigation → precedence + `needs_input`-on-conflict. Double-runs/lost processes → lease + idempotency + journal + boot recovery. False completion/blocking (the v1 sin) → verification contract + typed outcomes. Sibling scope overlap → detect + serialize.

---

## Implementation ownership (per Radan, mandatory)

- **Implementation → GPT-5.3-Codex-Spark** (effort tiered light/medium/high by task difficulty).
- **Advice / second opinion / design review → GPT-5.6-Sol** (used heavily).
- **Claude/Opus** orchestrates, authors specs/plans, and owns a **per-task independent cross-family review gate** — a fresh non-Codex reviewer for every implementation task (never Spark, never Sol, never the same reviewer instance carried between tasks).
