# Dependency-Serialized Dispatch — Implementation Plan

> **For agentic workers:** implement task-by-task, TDD, checkbox steps. Source of truth: `docs/superpowers/specs/2026-07-22-dependency-serialized-dispatch-design.md`.

**Goal:** Block an `execute`-phase dispatch until every `dependsOn` ticket is `done`; surface the block in the UI. Enforce server-side (unbypassable), fail-closed on missing deps.

**Tech:** Bun, TanStack Start (`createServerFn`), MongoDB standalone + Zod, react-query-kit, Tailwind, Vitest.

**Conventions:** server-fn boundary `createServerFn().validator(passthrough).handler(({data})=>boundary(Schema,data,core))`; cores in `*.server.ts`; `ServerResultError(code,msg)`; explicit-pick DTOs; smoke tests mirror `src/server/needs-input.smoke.test.ts` (real Mongo). `dispatchRun` lives in `src/server/supervisor.server.ts`; `TicketStatus` + lifecycle in `src/domain/stateMachine.ts` (`done` is terminal).

---

## Task 0: Baseline
- [ ] `git branch --show-current` → `feat/v3-dep-dispatch`. `export PATH="$HOME/.bun/bin:$PATH" && bun run test && bun run typecheck` green. No commit.

## Task 1: Pure `unmetDependencies` classifier + unit test
**Files:** Create `src/domain/dependencies.ts`; Test `src/domain/dependencies.test.ts`.

- [ ] **Step 1 (RED):** write `src/domain/dependencies.test.ts`. A dep is satisfied iff its ticket status is `"done"`. Classifier signature:

```ts
// dependencies.ts
import type { z } from "zod";
import type { TicketStatus } from "./schemas";
export type DepStatus = z.infer<typeof TicketStatus>;
export type UnmetReason = "pending" | "archived" | "missing";
export interface UnmetDependency { ticketId: string; seq: number | null; status: DepStatus | null; reason: UnmetReason; }

// deps: the ids this ticket depends on. present: the dep tickets that were found
// (id,seq,status). Any id in deps not in present is "missing". Any present dep with
// status "archived" is "archived"; status !== "done" (and not archived) is "pending".
export function unmetDependencies(
  deps: string[],
  present: { ticketId: string; seq: number; status: DepStatus }[],
): UnmetDependency[]
```

Test cases (table): empty deps → `[]`; all present & `done` → `[]`; a `running` dep → one `pending`; an `approved` dep → `pending`; an `archived` dep → `archived`; a dep id absent from `present` → `missing` (seq/status null); mixed → correct multiset. Assert `reason` + preserved id order of `deps`.

- [ ] **Step 2:** run → FAIL (module missing). **Step 3:** implement (build a `Map` from `present` by ticketId; iterate `deps` in order; classify). Pure, no I/O. **Step 4:** PASS + `bun run typecheck`. **Step 5:** commit `feat(deps): pure unmetDependencies classifier`.

## Task 2: Enforce in `dispatchRun` (execute phase) + smoke test
**Files:** Modify `src/server/supervisor.server.ts`; Test `src/server/dep-dispatch.smoke.test.ts`.

- [ ] **Step 1 (RED):** `src/server/dep-dispatch.smoke.test.ts` (real Mongo, mirror `needs-input.smoke.test.ts` bootstrap). Seed a board + ticket A and ticket B with `dependsOn:[A._id]`; drive B to `approved` (insert with status `approved`, `spec.approvedAt` set, `activeRunId:null`). Assert:
  - A in `inbox` → `dispatchRun(B,"execute")` throws `conflict` (message names A).
  - Set A `running` → still `conflict`. Set A `review_ready` → still `conflict`. Set A `done` → `dispatchRun(B,"execute")` succeeds (returns `{runId}`, B now `running`).
  - B with `dependsOn:["<24hex-not-in-db>"]` (approved) → `conflict` (missing dep, fail-closed).
  - A ticket with `dependsOn:[]` dispatches normally (regression).
  - Gating is execute-only: a ticket in `inbox` with an unmet dep still allows `dispatchRun(_,"spec_draft")` (deps don't gate spec drafting). *(Construct a valid spec_draft-eligible ticket with an unmet dep and assert no dep-conflict — if spec_draft has other preconditions, assert the failure is NOT the dependency conflict.)*

- [ ] **Step 2:** FAIL. **Step 3:** implement. In `supervisor.server.ts` add:

```ts
import { unmetDependencies } from "../domain/dependencies";
// ...
async function assertDependenciesMet(
  ticket: Ticket,
  ticketCollection: Collection<TicketDoc>,
): Promise<void> {
  if (ticket.dependsOn.length === 0) return;
  const ids = ticket.dependsOn.map((d) => new ObjectId(d));
  const docs = await ticketCollection
    .find({ _id: { $in: ids } })
    .project<{ _id: ObjectId; seq: number; status: TicketStatus }>({ seq: 1, status: 1 })
    .toArray();
  const present = docs.map((d) => ({ ticketId: d._id.toString(), seq: d.seq, status: d.status }));
  const unmet = unmetDependencies(ticket.dependsOn, present);
  if (unmet.length > 0) {
    const label = unmet
      .map((u) => (u.seq !== null ? `#${u.seq} (${u.reason})` : `${u.ticketId} (${u.reason})`))
      .join(", ");
    throw new ServerResultError("conflict", `blocked: waiting on dependencies ${label}`);
  }
}
```

Call it inside `dispatchRun` ONLY on the execute path — after `const policy = phasePolicy(ticket, phase);` and BEFORE the board load / CAS claim, guarded by `if (phase === "execute") await assertDependenciesMet(ticket, ticketCollection);`. (Confirm the `Phase`/`RunPhase` literal for execution is `"execute"`; adapt to the real literal. `Collection`/`TicketDoc`/`ObjectId`/`TicketStatus` imports already exist in this file — verify and reuse.)

- [ ] **Step 4:** PASS + typecheck. **Step 5:** commit `feat(deps): gate execute dispatch on unmet dependencies (fail-closed)`.

## Task 3: `dependencyStatus` read server fn + hook
**Files:** Modify `src/server/tickets.ts` (or a small new `src/server/dependencies.ts` core + wire into an existing server-fn module — match where sibling read fns live); Create/modify `src/queries/tickets.ts`.

- [ ] **Step 1:** core `dependencyStatusCore({ ticketId }) → { blocked: boolean; unmet: {ticketId; seq; title; status; reason}[] }`: load ticket, if `dependsOn` empty → `{blocked:false, unmet:[]}`; else load dep docs (project `seq,status,title`), run `unmetDependencies`, join title/status onto each unmet entry (title from the loaded docs; null when missing). `blocked = unmet.length > 0`. Return via a `.strict()` DTO schema (`DependencyStatusDTOSchema`). Server fn `dependencyStatus` (GET) via `boundary(TicketRefSchema, ...)` (reuse the existing single-ticket ref input schema; find it in `tickets.ts`).
- [ ] **Step 2:** hook `useDependencyStatus` in `src/queries/tickets.ts` mirroring existing query hooks (`unwrapResult`, static `queryKey:["dependencyStatus"]`, no `refetchInterval`). **Step 3:** typecheck + a small unit/dto test asserting no server-field leak + a blocked/not-blocked shape. Commit `feat(deps): dependencyStatus read fn + hook`.

## Task 4: UI — disable dispatch + annotate
**Files:** Modify `src/components/GateButtons.tsx` (or wherever the execute/dispatch control renders for an `approved` ticket), `src/components/TicketCard.tsx`.

- [ ] **Step 1:** In the dispatch control for an `approved` ticket, call `useDependencyStatus({ticketId})`; when `blocked`, **disable** the dispatch button and render inline `role="status"` "Blocked — waiting on: #a (pending), #b (missing)". When not blocked, unchanged. (Find the current execute/dispatch trigger — likely `useDispatch` in `GateButtons`/`RunsSection`; gate only the *execute* dispatch, not spec_draft/review_fix controls.)
- [ ] **Step 2:** `TicketCard.tsx`: the existing read-only `dependsOn` line — when the card can cheaply know unmet state, annotate "⧗ depends on #a, #b"; otherwise keep the plain line (do NOT add a per-card server round-trip on the board list — if `useDependencyStatus` per card is too chatty, keep TicketCard's line plain and rely on the detail view. Prefer plain line on the board to avoid N queries.) Document the choice in a code comment.
- [ ] **Step 3:** typecheck + build + existing tests green. Commit `feat(deps): surface dependency block in dispatch UI`.

## Task 5: Final gate
- [ ] `export PATH="$HOME/.bun/bin:$PATH" && bun run test && bun run typecheck && bun run build && echo GATE_OK`.

## Self-review
- Enforcement is server-side in `dispatchRun` (unbypassable), execute-phase only, fail-closed on missing deps. `done` is the satisfaction bar (flip-point documented). Pure classifier is the single source of truth for gate + read fn. No schema/state-machine change. Auto-fire deferred.
