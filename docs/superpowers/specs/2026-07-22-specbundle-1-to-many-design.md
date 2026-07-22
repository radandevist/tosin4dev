# SpecBundle 1:many — Design

Date: 2026-07-22
Status: approved, ready to plan
Parent: `2026-07-22-tosin4dev-chat-first-pivot-design.md` (north-star Decision C + §6 SpecBundle + §8 lock gate). Builds directly on the shipped chat slice (`2026-07-22-fast-path-chat-slice-design.md`).

## Product

Today a brainstorm session drafts **one** spec and creates **one** ticket. But a broad ask often decomposes into several tickets of differing nature. This slice makes the brainstorm→ticket step **1:many**:

**brainstorm → "Propose tickets" → the AI proposes a *bundle* of N linked ticket drafts (with split rationale + declared dependencies + order) → you review / edit / reorder / drop the split → Lock all → N `inbox` tickets created atomically, each carrying its dependencies, all flowing into the existing pipeline.**

## What changes from the chat slice

The chat slice's single-draft path (`draftSpecFromChat` → `proposedSpec: ChatDraft` → `createTicketFromChat` → 1 ticket) is **replaced** by a bundle path. The single-draft server fns/`proposedSpec` field are removed (no external consumers beyond the chat UI we own). Brainstorm chat turns themselves are unchanged.

## Domain

### New: `specBundles` collection

```ts
// A proposed (then locked) decomposition of a brainstorm into N tickets.
BundleMemberSchema = {
  localKey: string,          // stable within the bundle ("t1","t2"…); the AI assigns these
  title: string,
  type: TicketType,
  runner: RunnerName,
  spec: SpecInput,           // same shape createTicketCore accepts
  dependsOn: string[],       // localKeys of other members this one depends on
}

SpecBundleSchema = {
  sessionId: ObjectIdString,
  boardId: ObjectIdString,
  status: "drafting" | "locked",
  rationale: string,                 // why the ask was split this way
  members: BundleMember[],           // ordered; array order IS the ticket order
  lockedTicketIds: ObjectIdString[] | null,  // set at lock, aligned to members order; null while drafting
}
// Persisted doc adds _id, createdAt, updatedAt, lockedAt: string|null. DTO adds _id.
```

Members are **embedded** (not separate docs) — the bundle is edited as a unit before lock. `localKey` is the dependency currency until lock; at lock each `localKey` resolves to a created `ticketId`.

### `ChatSession` changes

- `proposedSpec: ChatDraft | null` → **removed**; replaced by `bundleId: ObjectIdString | null` (the current drafting/locked bundle for this session).
- `status` enum `"active" | "ticket_created" | "abandoned"` → `"active" | "bundle_locked" | "abandoned"` (`ticket_created` renamed; it always meant "this session produced tickets").
- `ticketId` (single) → **removed** (the bundle's `lockedTicketIds` is the record).

### `Ticket` changes

- Add **`dependsOn: ObjectIdString[]`** (default `[]`) — resolved dependency ticket ids. **Recorded and surfaced, not yet enforced** at dispatch (dependency-serialized auto-dispatch is a north-star non-goal for this slice). Legacy/form tickets default to `[]`.

## The bundle draft turn

`proposeBundleFromChat(sessionId)` replaces `draftSpecFromChat`. It **requires `session.status === "active"`** (a session already `bundle_locked` cannot re-propose — that is a deferred post-lock revision; reject with `conflict`). It runs a **draft-kind chat turn** (reusing the existing `startChatTurn(..., "draft")` machinery) with a **`BUNDLE_INSTRUCTION`** that asks the model to return ONLY a JSON object matching `{ rationale, members: [{localKey,title,type,runner,spec,dependsOn}] }`. Parsed by a new `parseBundle` (mirrors `parseDraft`: fenced-json tolerant, strict-schema-validated, fail-closed → null → `turnStatus:"error"`).

On success the monitor **upserts a `drafting` SpecBundle** for the session (replacing any existing *drafting* bundle for that session — re-proposing supersedes the prior draft) and sets `session.bundleId`. Because propose requires an `active` session, there is never a `locked` bundle to clobber. (The turn routing uses the existing `pendingKind:"draft"` path; the monitor branch that currently writes `proposedSpec` now writes the bundle instead.)

**Validation at parse time:** `localKey`s unique and non-empty; every `dependsOn` entry references an existing member `localKey`; **no self-dependency and no cycles** (a topological check — a cyclic proposal fails closed to `turnStatus:"error"` so the user re-proposes). At least one member.

## Editing the split (pre-lock)

Server fns operating on the `drafting` bundle (all reject if `status !== "drafting"`):

- `updateBundleMember(bundleId, localKey, patch)` — edit a member's title/type/runner/spec/dependsOn.
- `dropBundleMember(bundleId, localKey)` — remove a member; also strips it from any other member's `dependsOn`.
- `reorderBundle(bundleId, orderedLocalKeys)` — reorder members (validates the set is a permutation of current keys).

Each re-validates the invariants (non-empty members, dependency refs valid, acyclic) and fails closed on violation. `getBundle(bundleId)` returns the DTO for the review UI (polled/refetched after edits).

## Lock (the crux)

`lockBundle(bundleId)`:
1. Load bundle; require `status === "drafting"` (idempotent guard — a `locked` bundle returns conflict). Re-validate all invariants (members non-empty, deps valid + acyclic).
2. **CAS claim** `drafting → locked` (`updateOne({_id, status:"drafting"}, {$set:{status:"locked", lockedAt}})`; `matchedCount===0` → conflict). This serializes concurrent locks.
3. **Create the N tickets in members order**, tracking created ids. Each ticket is created via the existing `createTicketCore` (status `inbox`), then a second pass sets `dependsOn` by mapping each member's `dependsOn` localKeys → the created ticketIds.
4. **Compensation (no Mongo transactions — standalone):** if ANY ticket create fails, **delete all tickets already created in this lock**, revert the bundle to `drafting` (`status:"drafting", lockedAt:null`), and return a failure. All-or-nothing: either all N tickets exist and the bundle is `locked`, or none do and the bundle is back to `drafting` (retryable).
5. On success: set `bundle.lockedTicketIds` (aligned to members order), `session.status = "bundle_locked"`. Return the created `{ticketId, seq}` list.

Ticket `seq` allocation reuses `createTicketCore`'s existing per-board unique-index + retry (each create gets the next seq); the compensation deletes roll back a partial run.

## UI (Layout C, extending the chat workspace)

- Chat route gains a **"Propose tickets"** button (replaces "Draft spec from this chat") → `proposeBundleFromChat`.
- When the session has a `drafting` bundle, render a **SpecBundle review panel** (right side / below chat): the split rationale, then an ordered list of **member cards** (title/type/risk/intent + a `dependsOn` chip list). Each card: **edit** (compact form reusing the ticket-create fields), **drop**, and **move up/down** (reorder). A **"Lock all N tickets"** button → `lockBundle` → on success navigate to the board (tickets now present). Inline errors (`role="alert"`) on any failed edit/lock; Lock disabled while pending.
- Board `TicketCard` / ticket detail surface `dependsOn` (a small "depends on #a, #b" line) — read-only.

## Testing

- **Unit:** `SpecBundleSchema`/`BundleMemberSchema` (incl. fail-closed), `parseBundle` (fenced json, invalid → null), the **cycle/ref validator** (self-dep, cycle, dangling ref → invalid; valid DAG → ok), bundle DTO explicit-pick (no server-field leak).
- **Smoke (real Mongo, fake `claude`):** brainstorm → `proposeBundleFromChat` (fake emits a 3-member bundle with a dependency) → drafting bundle stored; edit/drop/reorder mutate correctly and re-validate; `lockBundle` → 3 real `inbox` tickets with resolved `dependsOn`, session `bundle_locked`, order preserved; **lock compensation** — a fake failure mid-create leaves 0 tickets and the bundle back at `drafting` (retryable); re-propose replaces a drafting bundle.
- Final gate: `bun run test && bun run typecheck && bun run build`.

## Non-goals / deferred

`specHash` + immutable post-lock revisions (`supersedesBundleId` version chain) — locked is final this slice; a post-lock change is a later slice. Dependency-**serialized** auto-dispatch (deps recorded/shown, dispatch stays manual). Overlapping-scope sibling serialization. Transcript-precedence ledger. EventJournal. Multi-bundle history UI. Second provider.

## Migration

Additive collection (`specBundles`) + `Ticket.dependsOn` (defaulted `[]`, legacy-safe). **Breaking within the unreleased chat feature only:** `ChatSession.proposedSpec`/`ticketId` and the `draftSpecFromChat`/`createTicketFromChat` server fns are removed and replaced by the bundle path — the chat slice shipped on `main` but is a new, single-user-local feature with no external consumers, so this is a clean replacement (update the chat UI + hooks accordingly), not a data migration. No change to the run/verification/state-machine path.
