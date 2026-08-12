# External Ticket Ingress — Design Spec

Date: 2026-08-05
Status: draft, awaiting owner review
Tracking: #16 (feature) · #15 (auth prerequisite, blocking)
Builds on: `2026-07-22-tosin4dev-chat-first-pivot-design.md`

## 1. Problem

Every ticket in Tosin4dev is born in front of the console. You open a chat session, brainstorm with a provider, and the session distills into a locked spec that becomes one or more tickets. That is the right authoring path and this spec does not change it.

But it is also the *only* path. Work that arrives from anywhere else — a GitHub issue on PublyApp, a Hermes/Discord message, a CI failure, a thought while away from the machine — has no way in. It has to be remembered and re-typed into a chat session later. The capture step is lossy and requires being at the desk.

The gap is **capture**, not authoring. We want work to land on the board; we still want it specced in chat.

## 2. What this is not

Prior art is [taskreaper-core](https://github.com/mdoty4/taskreaper-core), which ships a bearer-token ingress endpoint so "anything can drop a task in", plus a Jira poller.

We are borrowing the ingress idea and nothing else. That project's execution model — linear queue, one shared working directory, no worktrees, no verification, exit-code-as-done — is the model this project's v2 pivot deliberately inverted. See §2 of the pivot spec.

Explicit non-goals:

- **No auto-dispatch.** Not behind a flag, not for a "trusted" sender. See §4.
- **No auto-spec.** An ingressed ticket does not get a machine-written spec.
- **No pollers.** This is a push endpoint. A GitHub Action, a Hermes hook, or a cron job lives *outside* Tosin4dev and POSTs to it. Keeping integrations out of the console keeps their failure modes out too.
- **No multi-user auth.** A single shared secret. See #15.

## 3. The invariant that governs the design

> A ticket may only run from a locked spec.

An externally created ticket has no spec, so it must not be dispatchable. The critical observation is that **the existing state machine already guarantees this**, at no cost:

```ts
// src/domain/stateMachine.ts
"inbox:submit_spec": "spec_review",
```

`TicketStatus` begins at `inbox`, and `submit_spec` is the only edge out of it. A ticket created at `inbox` therefore cannot reach `approved` — and so cannot be dispatched — without passing through the same spec authoring and review that every hand-made ticket passes through.

This means ingress needs **no new status, no new edge, no new gate, and no change to the ticket lifecycle**. It is an insert at the existing entry point. That is what makes it a small slice rather than a risky one.

The design rule follows directly: *ingress may create a ticket at `inbox` and may do nothing else.*

## 4. Why auto-dispatch stays out, permanently

It is tempting to let a sufficiently-structured payload skip straight to `approved` — the caller could supply intent, scope, non-goals, acceptance and risk, which is everything the spec form collects.

Reject this, for two reasons.

**The spec is not the same artifact as the ticket fields.** Per the pivot spec's precedence rule, a locked spec is `SPEC.json` (binding) > approved decision ledger (approval-stamped, part of the ticket hash) > redacted transcript (non-normative). The decision ledger is the record of judgements *you* made and approved. A payload from a webhook has no ledger and cannot manufacture one. A ticket that runs without it is running on unreviewed intent.

**It converts a capture endpoint into a remote code execution endpoint.** The moment ingress can produce a runnable ticket, an HTTP request causes a `claude` or `codex` process to spawn in a worktree of a real repository with credentials on `PATH`. Landing at `inbox` keeps the endpoint's blast radius at "a row appeared on a board".

## 5. Interface

```http
POST /api/ingress/tickets
Authorization: Bearer <TOSIN4DEV_INGRESS_TOKEN>
Content-Type: application/json
```

```json
{
  "boardSlug": "publyapp",
  "title": "Campaign creation rejects archived sites",
  "body": "Reported in #742. Server accepts a siteId with no status check.",
  "source": "github",
  "sourceUrl": "https://github.com/org/repo/issues/742"
}
```

```json
201 { "ticketId": "66b0f2c4e1a2b3c4d5e6f7a8" }
```

Rules:

- **Strict schema.** Zod `.strict()`, consistent with every other boundary in the codebase. Unknown keys are a 400, so a caller cannot smuggle `status`, `activeRunId`, or a spec.
- **Board by slug, never implicit create.** Unknown slug is 404.
- **Always `inbox`.** Status is not caller-supplied; it is a constant in the insert.
- **Origin recorded.** `source` and `sourceUrl` persist on the ticket and appear on the board, so a ticket's provenance is visible without opening it. An activity row records the ingress event.
- **Size cap.** `title` and `body` bounded; oversized payload is 413. The body eventually reaches a provider prompt, so unbounded input is unbounded token spend.
- **Idempotency.** `source` + `sourceUrl` unique per board where both are present, so a webhook retry does not create duplicates. A repeat returns `200` with the existing `ticketId` rather than a second row.

## 6. Auth (depends on #15)

This endpoint must not ship before #15 is settled. The development server now binds to loopback by default, which removes the prior LAN exposure, but the app still has no authentication: any local process able to reach the console has full control, including `dispatchRun`. Adding a documented write API before the console has an authentication boundary would extend that control to another mutation surface.

Once #15 lands, ingress should reuse whatever it establishes rather than inventing a parallel scheme. The expected shape is a shared secret in `.env` compared in constant time. If #15 puts the check inside the server-fn `boundary` helper, ingress gets it by construction.

Ingress-specific requirements on top:

- A **separate token** from the console's, so it can be rotated or revoked without locking you out of the UI, and so a leaked webhook secret does not grant console access.
- Rate limiting. A stuck webhook retry loop should be throttled, not allowed to fill the board.
- Failed auth attempts logged (without the presented token).

## 7. Alternatives considered

**A file-drop directory watched by the server.** No HTTP surface, no auth, no network exposure — genuinely simpler and safer. Rejected because the senders that matter (GitHub Actions, Hermes, a phone) are not on the filesystem, and syncing a directory to reach them reintroduces the same trust question with more moving parts. Worth revisiting if the HTTP surface proves troublesome.

**Reuse a TanStack server function instead of a route.** Server fns are the existing convention and would inherit #15's check automatically. Rejected because their call contract is a framework-internal detail, unpleasant for third-party callers to depend on and free to change between framework versions. A documented REST endpoint is the stable contract an external integration needs.

**Ingress creates a `ChatSession` instead of a ticket.** Closer to the chat-first model: the payload seeds a brainstorm you later continue. Rejected for now as strictly more machinery for the same outcome — you still have to sit down and drive the session. Reconsider if ingressed tickets pile up unspecced, which would be the signal that capture was never the real bottleneck.

## 8. Decisions (owner, 2026-08-05)

1. **`source` is a free string**, lowercased on write and capped at 40 characters — not an enum. A new integration must never require a code change and a migration just to identify itself. The cost is that a typo produces a stray source value on the board; that is cosmetic and editable, and it is the cheaper failure.

2. **Ingress does not notify.** The ticket appears in `inbox` and waits. Discord notifications currently mean *something needs you now* — `blocked` and `review_ready` are both states where the system is stuck without you. A captured, unspecced ticket is not stuck; it is a queue entry. Notifying on arrival would dilute the signal until the channel stops being read, which costs more than the delay in noticing a new ticket.

3. **The board is named by slug only.** `boardSlug` is the single accepted reference; `boardId` is not accepted. A slug is writable by hand and readable in a payload during debugging. The failure mode of a renamed board is a loud 404 at the sender, not silent misrouting, and the number of integrations pointing at any one board is small enough to fix by hand. Accepting both would add a second validation path and an ambiguity (slug and id present but disagreeing) for a problem that has not occurred yet.
