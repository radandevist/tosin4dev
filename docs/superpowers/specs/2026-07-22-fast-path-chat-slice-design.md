# Fast-Path Thin Chat Slice — Design

Date: 2026-07-22
Status: approved, ready to plan
Parent: `2026-07-22-tosin4dev-chat-first-pivot-design.md` (north-star). This is a deliberately **thin** subset of north-star step 5 (chat adapters + UI), chosen as the fast-path to a first testable end-to-end loop. It intentionally defers most of steps 4–5.

## Product

The first testable end-to-end loop that reflects how Radan works with AI:

**brainstorm in a chat panel → draft a spec from that conversation → create one ticket → the ticket flows into the already-shipped autonomous run → verify → needs_input pipeline.**

One provider (Claude), one brainstorm session → **one** ticket. No multi-ticket split, no transactional bundle lock, no second provider, no live token streaming — those are later slices. The value here is *feeling the whole loop*.

## The one architectural choice (decided): turn-based transport

Chat is **turn-based**, not live-token-streaming. Each user message is one batch turn via the existing Claude adapter (`claude -p <prompt> --output-format json [--resume <sessionId>]`), run asynchronously and surfaced by **polling** — the same dispatch→poll convention the app already uses for runs/log tails. No SSE, no `ReadableStream` route, no Agent SDK dependency.

Rationale: human-paced brainstorming is naturally turn-by-turn; `--resume` per message is a faithful brainstorm loop; this reuses ~all existing infra (adapter, `parseSessionId`, spawn/monitor, react-query polling). True token-streaming (Agent SDK + SSE) is a UX-polish follow-up slice, not loop-completeness. The north-star's Agent-SDK preference targets the *execution* session's mid-turn steering, which brainstorming does not need.

## Why turns are async + polled (not a blocking server fn)

A `claude -p` brainstorm turn can take tens of seconds. A synchronous server function holding that request risks proxy/HTTP timeouts and gives no progress feedback. So a turn is modeled as a lightweight job, mirroring runs (minus worktree/branch/verification):

- `sendChatMessage` appends the user message, records a **pending assistant turn**, spawns `claude -p` detached in the board repo cwd, and returns immediately.
- A background monitor drains stdout, and on process exit parses the final JSON → captures the assistant text (`result`) and, on the first turn, the provider `session_id` (via the existing `parseSessionId`).
- The client **polls `getChatSession`** (react-query `refetchInterval`, gated like `shouldPollRun`) until the pending turn resolves into an assistant message (or an error state).

Exactly one pending turn per session at a time (a simple guard): `sendChatMessage` refuses if a turn is already pending. Fail-closed: a nonzero exit, unparseable output, or spawn failure resolves the pending turn to an `error` state carrying a message; the session stays usable (the user can retry). This matches the verification kernel / slice B fail-closed posture.

## Domain — `ChatSession` (new, minimal)

New collection `chatSessions`. No `EventJournal`, no `SpecBundle` — messages are stored inline; simplicity over the provisional north-star shapes (which stay deferred).

```ts
// src/domain/schemas.ts additions
ChatMessageSchema = {
  role: "user" | "assistant",
  text: string,
  at: string /* ISO */,
}

ChatTurnStatus = "idle" | "pending" | "error"   // session-level turn state

ChatSessionSchema = {
  boardId: ObjectIdString,
  provider: "claude",                 // only claude in this slice (RunnerName-compatible literal)
  sessionId: string | null,           // provider conversation id, captured on the first turn; null until then
  status: "active" | "ticket_created" | "abandoned",
  turnStatus: ChatTurnStatus,         // "pending" while a turn is spawned; "error" if the last turn failed
  turnError: string | null,           // human-readable reason when turnStatus === "error"
  messages: ChatMessage[],            // append-only in practice
  proposedSpec: ChatDraft | null,     // last draftSpecFromChat result, awaiting confirm; null otherwise
  ticketId: ObjectIdString | null,    // set when a ticket is created from this session
}
// Persisted doc (chatSessions.server.ts) adds: _id, createdAt, updatedAt, and the
// server-owned turn bookkeeping: pid | null, logFile (per-session stdout capture path),
// pendingUserMessageAt (to detect/timeout a stuck turn), and
// pendingKind: "message" | "draft" | null  — tells the background monitor where to
// route the resolved turn output (append an assistant message vs. store proposedSpec).
// DTO (chat.ts) adds _id; never leaks pid/logFile/pendingKind.
// ChatDraft = z.infer<ChatDraftSchema> (defined below).
```

Persisted-doc/DTO split mirrors the Run/RunDTO pattern (`toDTO` explicit field-pick, `.strict()` — the pattern hardened in slice B; do NOT spread).

## Server functions (TanStack `createServerFn`, boundary/ServerResult pattern)

All in the established `createServerFn(...).validator(passthrough).handler(({data}) => boundary(Schema, data, coreFn))` shape; cores in `*.server.ts`.

- `createChatSession({ boardId })` → validates the board exists; inserts an `active` session with empty messages, `turnStatus:"idle"`, `sessionId:null`; returns `{ id }`.
- `sendChatMessage({ sessionId, text })` → loads session; **rejects if `turnStatus === "pending"`** (conflict); appends the user message; sets `turnStatus:"pending"`; spawns `claude -p <text> [--resume <session.sessionId>] --output-format json` (reuse `adapters.claude.buildCommand`-style construction, or a dedicated small chat command builder) in `board.repoPath` cwd, stdout→logFile; persists pid; returns immediately. A background monitor (same `spawn`/drain/`settledExit` helpers as the supervisor) finishes the turn.
- `getChatSession({ sessionId })` → returns the session DTO (messages + turnStatus + turnError). This is the poll target.
- `draftSpecFromChat({ sessionId })` → a **synchronous-feeling but same async-turn** operation: spawns a turn instructing the model to return ONLY a JSON object matching the ticket-draft shape (below); on resolution stores the proposed draft on the session (a `proposedSpec` field) rather than a chat bubble; the client polls and then renders it for confirmation. (Kept as its own action so the brainstorm transcript is not polluted and the output is machine-parseable.)
- `createTicketFromChat({ sessionId })` → validates a `proposedSpec` exists; calls the existing `createTicketCore` with it; sets session `status:"ticket_created"`, `ticketId`; returns `{ ticketId, seq }`.

**Ticket-draft shape** (what `draftSpecFromChat` asks the model to emit, Zod-validated; a superset of `CreateTicketInput` minus server-owned fields):

```ts
ChatDraftSchema = {
  title: string,
  type: TicketType,                    // research|spec|implement|bugfix|review
  runner: "claude" | "codex",          // proposed executor for the ticket (defaults claude)
  spec: { intent, scope, nonGoals, acceptance: string[], links: string[], risk }
}
```

Parse failure (model returned prose or invalid JSON) ⇒ `turnStatus:"error"` with a retry-able message; never a half-built ticket (fail-closed).

## Chat turn execution (server-side)

A new small module (e.g. `src/server/chat.server.ts`) reuses the supervisor's process primitives (`spawn`, `drainStream`, `settledExit`, `waitForSpawn`, `parseSessionId`) — extracted/shared if practical, otherwise a focused local copy to avoid coupling chat to run-specific logic. A chat turn is: spawn → drain stdout to logFile → on exit parse the last JSON line → `{ result, session_id }` → append assistant message (or set the proposed draft), capture `sessionId` if first turn, set `turnStatus:"idle"`. No worktree, no branch, no verification, no Evidence.

Boot recovery: a chat session left `pending` by a crash is reconciled to `error` ("interrupted") on next read if its `pid` is dead / `pendingUserMessageAt` is older than a timeout — a light analogue of `recoverOrphans` (full daemon recovery stays out of scope; a stuck brainstorm turn is low-stakes and user-retryable).

## UI (Layout C, thin)

- **Entry point:** a "Brainstorm" button on the board screen (`b/$boardSlug.tsx` header, next to "New ticket") → `createChatSession` → navigate to the chat route.
- **Chat route:** `src/routes/b/$boardSlug/chat/$sessionId.tsx` — a fuller-screen view (per Layout C), not the small overlay. Left/main: message list (user + assistant bubbles) + a textarea/send. `useChatSession` polls while `turnStatus === "pending"` (react-query `refetchInterval`, stops when idle/error — same pattern as `shouldPollRun`). Send disabled while pending or empty; `turnError` shown inline (`role="alert"`).
- **Draft → ticket affordance:** a "Draft spec from this chat" button → `draftSpecFromChat` → (poll) → renders the proposed `ChatDraftSchema` (title/type/risk/intent/scope/nonGoals/acceptance/links) in a read-only-ish confirm card with a "Create ticket" button → `createTicketFromChat` → navigate to the new ticket detail. (Editing the proposed spec before creation is deferred — the user can edit via the existing ticket spec UI after creation; keep this slice to propose→confirm→create.)
- The **live split-preview pane** (north-star §9) is deferred; the confirm card is its thin stand-in.
- react-query hooks in `src/queries/chat.ts` following the established `createQuery`/`createMutation` + `getKey` + caller-invalidation conventions.

## SSH-browser accessibility

The Vite dev server (`vite dev --port 3141`) must be reachable from Radan's Windows client (`192.168.0.248`) against the Linux host (`192.168.0.68`). Bind the dev server host (Vite `server.host`) and record the chosen dev host in the repo `.env`/config per the multi-clone-host rule (`DEV_HOST`). Session/auth cookies scope by host — since this slice adds no auth, a plain host/IP binding suffices; if a hostname is used, provide Radan the `sudo tee -a /etc/hosts` one-liner (no sudo available to the agent). Concretely: allow access via `http://192.168.0.68:3141` (host binding) as the minimum, with an optional `t4d-0.localhost`-style slug if preferred.

## Testing

- **Unit:** `ChatSessionSchema`/`ChatDraftSchema` validation incl. fail-closed parse; `toDTO` explicit-pick round-trip (regression-guard like `runs.dto.test.ts`); the turn-state guard (reject send while pending); poll-gating predicate (pending → poll, idle/error → stop).
- **Smoke (mirrors `needs-input.smoke.test.ts`):** a fake `claude` on PATH that emits a canned `--output-format json` reply → `sendChatMessage` → monitor resolves → assistant message appended + `sessionId` captured; a second turn resumes with `--resume`; `draftSpecFromChat` with a fake JSON reply → `createTicketFromChat` → a valid `inbox` ticket exists and is dispatchable through the existing pipeline. Fake runner emitting nonzero/garbage → `turnStatus:"error"`, session still usable.
- No component-test harness exists (as in slice B); behavioral gate = smoke + unit. Final gate: `bun run test && bun run typecheck && bun run build`.

## Non-goals / deferred (explicit)

Live token streaming (Agent SDK + SSE); Codex provider (App Server); SpecBundle 1:many + transactional lock + precedence/hashing; live split-preview; transcript-precedence consultation; EventJournal; editing the proposed spec in-chat before creation; multi-session management UI; auth. The brainstorm session is **not** the execution session (north-star §3E) — this slice only creates a ticket; execution still uses the ticket's own run sessions.

## Migration

Additive: one new collection (`chatSessions`), new domain schemas, new server fns, new route + hooks. No changes to existing collections, the state machine, or the run/verification path. Existing form-authored ticket creation is untouched (the chat path funnels into the same `createTicketCore`).
