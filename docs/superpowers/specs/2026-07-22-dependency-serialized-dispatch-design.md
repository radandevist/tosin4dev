# Dependency-Serialized Dispatch — Design

Date: 2026-07-22 (night-shift, self-approved conservative — for morning review)
Parent: SpecBundle 1:many (`2026-07-22-specbundle-1-to-many-design.md`) shipped `Ticket.dependsOn` as **recorded but not enforced**. This slice enforces it.

## Product

A ticket created from a locked bundle carries `dependsOn: ObjectIdString[]` (resolved dependency ticket ids). Today that's advisory only — you can dispatch an execution run on a ticket whose prerequisites aren't finished. This slice makes dispatch **dependency-serialized**: a ticket's **execution** run is blocked until all its dependencies are complete, and the UI shows exactly what it's waiting on.

**Scope this slice = ENFORCE + SURFACE, not auto-fire.** The server rejects a premature execute-dispatch; the UI disables the run affordance and names the pending dependencies. A background watcher that *automatically* fires the run the moment the last dependency completes is **deferred** (it was the north-star's "dependency-serialized auto-dispatch" non-goal; enforcement is the crisp core and the safe half to ship unattended).

## Key decisions (conservative; flip-points flagged for review)

1. **"Satisfied" = dependency ticket status is `done`.** `done` is the lifecycle terminal (`review_ready:approve_final → done`) meaning the work was produced, passed verification, AND accepted by the human. **Flip-point:** a looser bar of `review_ready` (work produced + verified, awaiting final human sign-off) would let dependents start sooner. Chose `done` as the safe default; one-line change if you prefer `review_ready`.
2. **Only the `execute` phase is gated.** `spec_draft` and `review_fix` are not dependency-gated — you can draft/refine a dependent ticket's spec regardless of its prerequisites; dependencies constrain *execution ordering*, not spec authoring.
3. **An `archived` dependency does NOT satisfy and does NOT auto-clear.** A dependent whose dep was archived (abandoned) stays blocked and surfaces "waiting on archived dependency #X — edit dependsOn to unblock". Rare; treated as a documented manual-resolution edge, not auto-resolved (auto-clearing an archived dep is a product judgment parked for you).
4. **Self/dangling safety:** `dependsOn` was validated acyclic + self-ref-free at bundle lock; form-authored tickets default `[]`. The check tolerates a dangling id (a dep ticket that no longer exists) by treating it as **unsatisfied** (fail-closed: unknown dep ⇒ blocked, surfaced as "missing dependency #X").

## Server (the enforcement point)

`dispatchRun(ticketId, phase)` (`src/server/supervisor.server.ts`) is the single authoritative dispatch gate (CAS-claims `approved → running` for execute). Add, for `phase === "execute"` only, BEFORE the CAS claim:

```
assertDependenciesMet(ticket, ticketCollection):
  if ticket.dependsOn.length === 0 → return   // fast path
  load the dep tickets by _id ($in)
  unmet = deps where status !== "done" (a missing dep id counts as unmet)
  if unmet.length > 0 → throw ServerResultError("conflict",
     "blocked: waiting on dependencies " + unmet ids/seqs)
```

Pure helper `unmetDependencies(ticket, depDocs): {ticketId, seq, reason}[]` (reason: `"pending"` | `"archived"` | `"missing"`) so both the gate and a read path share one classifier. A new **read** server fn `dependencyStatus({ ticketId }) → { blocked: boolean, unmet: {ticketId, seq, title, status, reason}[] }` powers the UI without duplicating logic.

The check is inside `dispatchRun` (not just the UI) so it can't be bypassed by a direct server-fn call — matching the fail-closed posture.

## UI (surface the block)

- On the ticket detail / `GateButtons`, when the ticket is `approved` (dispatch-eligible) AND `dependencyStatus.blocked`: **disable** the execute/dispatch control and render an inline note "Blocked — waiting on: #a (running), #b (approved)" (`role="status"`). Non-blocking (all deps done, or none) → normal dispatch.
- `TicketCard` already shows the read-only `dependsOn` line; extend it to tint/annotate unmet deps ("⧗ depends on #a, #b") so the board shows what's waiting. Read-only.
- react-query hook `useDependencyStatus({ ticketId })` (no polling; invalidated when any ticket on the board transitions — reuse the existing ticket-list invalidation).

## Testing

- **Unit:** `unmetDependencies` classifier — all `done` → []; a `running`/`approved` dep → `pending`; an `archived` dep → `archived`; a missing id → `missing`; empty deps → []. Pure, table-driven.
- **Smoke (real Mongo):** seed board + two tickets where B `dependsOn:[A]`; approve B; `dispatchRun(B,"execute")` → **conflict** while A is `inbox/running/review_ready`; advance A to `done`; dispatch B → succeeds (run created). A dangling/missing dep id → conflict. `spec_draft`/`review_fix` phases NOT gated (dispatch allowed regardless of deps).
- Final gate: `bun run test && bun run typecheck && bun run build`.

## Non-goals / deferred (parked for you)

Background **auto-fire** when the last dep completes (this slice only *unblocks*, the human still clicks run). Auto-clearing an `archived` dependency. `review_ready` (vs `done`) satisfaction bar. Cross-board dependencies (deps assumed same-board, as bundle lock guarantees). Dependency-aware ordering *hints* in a queue view.

## Migration

Purely additive: one pure helper, one guard inside `dispatchRun`, one read server fn + hook, UI annotations. No schema change (`dependsOn` already exists). No change to the state machine or the run/verification path. Legacy tickets (`dependsOn: []`) are unaffected (fast-path return).
