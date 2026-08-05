# External Ticket Ingress — Implementation Plan

Date: 2026-08-05
Tracking: #16 · blocked by #15
Design: `docs/superpowers/specs/2026-08-05-external-ticket-ingress-design.md`

Each task is one commit. Every task states what proves it. Do not start Task 3 before #15 has landed — Tasks 1 and 2 are safe to build first because neither is reachable over the network.

## Task 0: Baseline

Confirm the tree is green before touching anything, so a later failure is attributable.

```
bun run typecheck
bun run test
```

Record the file/test counts. Everything below must keep them green.

---

## Task 1: Persist ticket origin

**Why first:** it is the only schema change, it is additive, and it is independently useful — a hand-made ticket can carry a source too.

- `TicketSchema` (`src/domain/schemas.ts`): add
  ```ts
  // Free string, not an enum: a new integration must never need a code change
  // and a migration just to name itself. Lowercased on write so `GitHub` and
  // `github` are one source, not two.
  source: z
    .string()
    .min(1)
    .max(40)
    .transform((value) => value.toLowerCase())
    .nullable()
    .default(null),
  sourceUrl: z.string().url().max(2048).nullable().default(null),
  ```
- Add the identical fields to the ticket DTO schema. It is `.strict()`, so omitting them there silently drops the fields from every ticket the UI receives — the same failure mode that bit `RunTurnDTOSchema` during the slice 4–6 stack.
- Default `null` so every existing ticket document parses unchanged.

**Proves it:**
- A ticket document written before this change parses through both schemas with `source: null`.
- A ticket with `source`/`sourceUrl` set round-trips through the DTO without being dropped.

---

## Task 2: `createIngressTicketCore`

Pure server-side core, no HTTP. Same shape as the other `*Core` functions so it is unit-testable without a request.

```ts
export async function createIngressTicketCore(input: {
  boardSlug: string;
  title: string;
  body: string;
  source?: string;
  sourceUrl?: string;
}): Promise<{ ticketId: string; created: boolean }>
```

- Resolve the board by slug; unknown slug throws `ServerResultError("not_found", ...)`.
- Idempotency: if `source` and `sourceUrl` are both present and a ticket already exists on that board with the same pair, return its id with `created: false`. Enforce with a partial unique index on `{boardId, source, sourceUrl}` — application-level checks race.
- Insert at `status: "inbox"`. Status is a literal in the insert, never from input.
- Push an activity row recording the ingress and its source.
- Leave `activeRunId` null and touch nothing else.
- **Do not notify.** No `notify()` call on this path. Discord means "something needs you now"; an unspecced ticket in `inbox` does not.
- Board is resolved by **slug only**. Do not accept a `boardId` — one reference, one validation path, no slug/id disagreement to resolve.

**Proves it:**
- Creates exactly one ticket, at `inbox`, on the named board.
- Unknown slug throws and writes nothing.
- Two identical calls with the same `source`+`sourceUrl` yield one ticket, `created: false` on the second.
- Two calls with the same pair but *different* boards yield two tickets.
- `source: "GitHub"` is stored as `github`, so casing does not fork a source.
- No Discord notification is emitted on this path (spy on `notify` and assert it was not called).
- Concurrent identical calls yield one ticket (drive both without awaiting the first).
- **The invariant test:** an ingressed ticket cannot be dispatched. Call `dispatchRun` on it and assert it is refused, and that only `submit_spec` moves it forward.

---

## Task 3: The HTTP route — DO NOT START BEFORE #15

- `POST /api/ingress/tickets`.
- Auth first, before parsing: `Authorization: Bearer <TOSIN4DEV_INGRESS_TOKEN>` compared with `crypto.timingSafeEqual` on equal-length buffers. Missing/empty configured token means the route is **disabled**, not open.
- Reuse whatever #15 established; do not invent a second scheme. Use a distinct token from the console's.
- Body cap (~64 KB) enforced before parsing; oversized is 413.
- Zod `.strict()` on the body; failure is 400 with the existing error shape and no detail that echoes the token.
- Map `ServerResultError` codes to status: `not_found` → 404, `conflict` → 409, else 400. Success is 201 (or 200 on idempotent repeat).
- Log failed auth attempts without the presented token.

**Proves it:**
- Valid token + valid body → 201 and exactly one ticket.
- Missing / malformed / wrong-length / wrong-value token → 401 and **no ticket written** (assert the collection count, not just the status code).
- Unset `TOSIN4DEV_INGRESS_TOKEN` → route disabled, 404/401, no ticket.
- Unknown key in body → 400, no ticket.
- Caller-supplied `status: "approved"` → 400 (`.strict()` rejects it), no ticket.
- Oversized body → 413, no ticket.
- Unknown `boardSlug` → 404, no ticket.

---

## Task 4: Surface origin on the board

- Show the source on the ticket card / detail when `source` is set, linking `sourceUrl` when present.
- Escape/validate the URL before rendering it as a link — it is attacker-influenced input. Only `http`/`https`; the Zod `.url()` in Task 1 is a parse check, not a scheme allowlist.

**Proves it:**
- A ticket with a source renders it and links out.
- A ticket without one renders unchanged (no empty affordance).
- A `javascript:` URL is not rendered as a live link.

---

## Task 5: Document it

- `README.md`: a short "External ingress" section — enabling it, the env var, one `curl` example, and the explicit statement that ingressed tickets land in `inbox` and are never auto-run.
- `.env.example`: add `TOSIN4DEV_INGRESS_TOKEN=` with a comment that leaving it unset disables the route.
- State the trust boundary agreed in #15.

---

## Task 6: Final gate

```
bun run typecheck
bun run test
bun run build
```

Then re-assert the invariant end to end, by hand: POST a ticket in, confirm it appears at `inbox`, confirm the UI offers no run action, and confirm it only becomes runnable after `submit_spec` → `spec_review` → `approved`.

## Self-review

- Is there **any** path from an HTTP request to a spawned agent process? There must not be.
- Does any field in the request body reach a ticket field that the state machine trusts?
- Is the auth check genuinely before body parsing, so an unauthenticated caller cannot reach the Zod layer or the size logic?
- Does a failed auth or a failed parse leave zero rows written?
- Are the new DTO fields present in **both** the domain schema and the strict DTO?
