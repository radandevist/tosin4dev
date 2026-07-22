# Slice B — Durable Turns / Needs Input Design

Date: 2026-07-22
Status: approved, ready to plan
Parent: `2026-07-22-tosin4dev-chat-first-pivot-design.md` (this is decomposition step 2, the *minimal* value-bearing slice — the full `Run→Turn`/`EventJournal`/lease rework is deferred).
Builds on: the shipped verification kernel (`verify.server.ts`, gated `finishRun`, named per-run branch, Evidence).

## Product

Today a run is single-shot: dispatch → runner exits → verify → `review_ready`/`blocked`. This slice adds the missing autonomous behavior: **a run can pause to ask the human a decision it can't make under the locked spec, and resume on the answer.** The ticket moves to a new **Needs Input** column; the human answers via a minimal "Provide input" box (not the chat panel — that's slice D); the runner resumes the *same conversation in the same worktree* and continues to `completed` (→ verify) or asks again.

## The outcome contract (the crux)

The execute/review_fix runner brief instructs the agent to **finish by writing `<runDir>/outcome.json`** where `<runDir>` = `${board.repoPath}/.tosin4dev/runs/<runId>`:

```json
{ "outcome": "completed" | "needs_input" | "failed",
  "question": "…",   // required when needs_input
  "reason": "…",     // optional, for failed
  "summary": "…" }   // short human summary (replaces the stdout SUMMARY section for execute runs)
```

Zod-validated (`RunOutcomeSchema`). **Missing / unparseable / invalid ⇒ treated as `failed`** (fail-closed, matching the verification kernel). A nonzero process exit still fails fast *before* reading the outcome (unchanged).

## Session capture + resume (topology §3E)

To resume the *same* provider conversation, the execute/review_fix runner is invoked with **structured output** and its session id is captured and stored on the `Run`:

- **claude**: `claude -p <prompt> --output-format json` → parse `session_id` from the final result JSON. Resume: `claude -p <answer> --resume <sessionId> --output-format json`.
- **codex**: `codex exec --json …` → parse `thread_id` from the `thread.started` event. Resume: `codex exec resume <threadId> --json … <answer>` (spike-confirmed: `exec resume` accepts the thread id; cwd/sandbox go as root-level flags `codex -C <workDir> -s workspace-write exec resume …`).

cwd is pinned to the run's worktree on every turn (spike-confirmed: a cwd mismatch silently forks a Claude session). `spec_draft` is unchanged — it stays plain-text output with the `SUMMARY` section and never writes an outcome file.

## State + domain changes

- **`TicketStatus`** gains `needs_input`. **`HUMAN_GATES`** gains `needs_input` (it waits on a human decision, per parent §8).
- **Events** (`stateMachine.ts`): add `run_needs_input` (machine-only — excluded from `PublicEventSchema`) and `provide_input` (public). **Transitions:** `running:run_needs_input → needs_input`, `needs_input:provide_input → running`. `archive` remains universal.
- **`RunStatus`** gains `awaiting_input` (a *parked*, non-terminal run state). **`RunSchema`** gains `executionSessionId: string|null`, `awaitingQuestion: string|null`. **`failureKind`** gains `runner_reported_failure`.
- A `needs_input` run **keeps the ticket's `activeRunId`** (it is parked, not finished) — unlike the succeeded/failed helpers which clear it.

## Resume flow

`provideInput(ticketId, answer)` (public server fn, boundary/ServerResultError pattern):
1. Load ticket; require `status === "needs_input"` and a non-null `activeRunId`.
2. Record the answer as activity; transition `needs_input → running` (optimistic, guarded on the read status).
3. `resumeRun(runId, answer)`: re-spawn the runner **in the same worktree** (reuse `run.workDir`/`branch`/`executionSessionId`) with the resume command + the answer as the new prompt; set the run back to `running`; re-attach `monitorChild`. The resumed turn writes a fresh `outcome.json` → same processing (loop or complete).

The **same Run doc** is reused across the running → needs_input → running cycle (no per-turn Run docs — that is the deferred Turn model). The worktree/branch persists across the cycle.

## UI (minimal)

- Board: a **Needs Input** column (map the new status in the board grouping + `TicketCard`).
- Ticket detail: when the active run is `awaiting_input`, show `awaitingQuestion` and a **Provide input** textarea + button → `provideInput`. Not the chat panel.

## Non-goals / deferred

Full `Run→Turn` + `EventJournal` + leases/idempotency; the chat brainstorming panel + SpecBundle (slices C/D); multi-question threading beyond the simple loop; `permission_required`/`waiting_dependency` outcomes (only `completed`/`needs_input`/`failed` now).

## Migration

Additive. New enum members + nullable-defaulted Run fields (fix existing Run object literals in `dispatchRun` + smoke tests, as the verification-kernel plan did). Legacy runs have `executionSessionId: null` → not resumable, which is correct (they predate the contract). `spec_draft` path untouched.
