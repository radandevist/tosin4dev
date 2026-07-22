# SpecBundle 1:many Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One brainstorm session proposes N linked ticket drafts (rationale + dependencies + order); the human edits/reorders/drops the split, then Locks → N `inbox` tickets are created atomically (compensation-based, standalone Mongo), each carrying resolved `dependsOn`, all flowing into the existing pipeline.

**Architecture:** New `specBundles` collection (embedded `members`, `drafting`→`locked`). The chat "draft" turn now emits a *bundle* (`parseBundle` + a pure dependency/cycle validator) which the monitor upserts as a `drafting` bundle. Edit/reorder/drop/lock server fns operate on the drafting bundle; `lockBundle` CAS-claims `drafting`→`locked`, creates tickets via the existing `createTicketCore`, resolves `localKey`→`ticketId` for `dependsOn`, and rolls back (deletes) all created tickets on any failure. The chat slice's single-draft path (`proposedSpec`/`draftSpecFromChat`/`createTicketFromChat`) is REPLACED by the bundle path.

**Tech Stack:** Bun, TanStack Start (React 19, `createServerFn`), MongoDB official driver (standalone — no transactions) + Zod at boundaries, react-query-kit, Tailwind 4, Vitest.

**Source of truth:** `docs/superpowers/specs/2026-07-22-specbundle-1-to-many-design.md`. Read it first.

**Conventions reused (do not reinvent):**
- `.strict()` explicit-pick DTO (never spread): `src/server/chat.server.ts` `chatToDTO`; regression-test style `src/server/chat.dto.test.ts`.
- Server-fn boundary: `createServerFn({method}).validator(passthrough).handler(({data}) => boundary(Schema, data, coreFn))` (`src/server/chat.ts`).
- CAS-claim: `updateOne({_id, status:"X"}, {$set:{status:"Y"}})` + `matchedCount===0`→`conflict` (`createTicketFromChatCore`, `startChatTurn`).
- react-query-kit hooks + caller-invalidation (`src/queries/chat.ts`).
- Smoke harness: fake `claude` on PATH + real Mongo (`src/server/chat.smoke.test.ts`).
- Ticket creation: `createTicketCore` (`src/server/tickets.server.ts`) returns `{id, seq}`, status `inbox`.

**No-circular-import rule (important):** `specBundles.server.ts` may `import type { ChatSessionDoc } from "./chat.server"` (type-only, erased) and access the `chatSessions` collection via `db().collection<ChatSessionDoc>("chatSessions")` directly — it must NOT value-import `chat.server.ts`. `chat.server.ts` value-imports `replaceDraftingBundle` from `specBundles.server.ts` (one direction only).

---

## Task 0: Baseline

- [ ] **Step 1:** `git branch --show-current` → `feat/v2-specbundle`. `export PATH="$HOME/.bun/bin:$PATH" && bun run test && bun run typecheck` → all green (169), exit 0. No commit.

---

## Task 1: Domain — SpecBundle schemas, Ticket.dependsOn, ChatSession changes

**Files:** Modify `src/domain/schemas.ts`; Test `src/domain/specBundle.schema.test.ts`. Ripples: `src/server/chat.server.ts`, `src/server/chat.ts`, `src/server/chat.dto.test.ts` (remove `proposedSpec`/`ticketId`, rename status), `src/server/tickets.ts` (TicketDTO gets `dependsOn`).

- [ ] **Step 1: Write failing schema test** — create `src/domain/specBundle.schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BundleMemberSchema,
  SpecBundleProposalSchema,
  SpecBundleSchema,
  TicketSchema,
} from "./schemas";

const member = {
  localKey: "t1",
  title: "Add auth",
  type: "implement",
  runner: "claude",
  spec: { intent: "login", scope: "", nonGoals: "", acceptance: [], links: [], risk: "low" },
  dependsOn: [],
};

describe("spec bundle schemas", () => {
  it("accepts a member and defaults dependsOn to []", () => {
    const m = BundleMemberSchema.parse({ ...member, dependsOn: undefined });
    expect(m.dependsOn).toEqual([]);
  });
  it("rejects a member with an unknown top-level key (strict)", () => {
    expect(() => BundleMemberSchema.parse({ ...member, extra: 1 })).toThrow();
  });
  it("accepts a proposal of rationale + members", () => {
    const p = SpecBundleProposalSchema.parse({ rationale: "split by concern", members: [member] });
    expect(p.members).toHaveLength(1);
  });
  it("accepts a persisted bundle and defaults lockedTicketIds to null", () => {
    const b = SpecBundleSchema.parse({
      sessionId: "507f1f77bcf86cd799439011",
      boardId: "507f1f77bcf86cd799439012",
      status: "drafting",
      rationale: "r",
      members: [member],
    });
    expect(b.lockedTicketIds).toBeNull();
    expect(b.status).toBe("drafting");
  });
  it("Ticket defaults dependsOn to []", () => {
    const t = TicketSchema.parse({
      boardId: "507f1f77bcf86cd799439012",
      seq: 1, title: "x", type: "implement", status: "inbox", runner: "claude",
      spec: { intent: "y" },
    });
    expect(t.dependsOn).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** — `bunx vitest run src/domain/specBundle.schema.test.ts` → FAIL (schemas not exported / `dependsOn` missing).

- [ ] **Step 3: Add `dependsOn` to `TicketSchema`** — in `src/domain/schemas.ts`, inside `TicketSchema` (after `activity`):

```ts
  // Resolved dependency ticket ids (set at bundle lock; [] for standalone/legacy
  // tickets). Recorded and surfaced but NOT yet enforced at dispatch.
  dependsOn: z.array(ObjectIdString).default([]),
```

- [ ] **Step 4: Add the bundle schemas** — append to `src/domain/schemas.ts` (after `ChatSessionSchema`):

```ts
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
```

- [ ] **Step 5: Change `ChatSessionSchema`** — replace the `status`/`proposedSpec`/`ticketId` lines:

```ts
  status: z.enum(["active", "bundle_locked", "abandoned"]).default("active"),
  turnStatus: ChatTurnStatus.default("idle"),
  turnError: z.string().nullable().default(null),
  messages: z.array(ChatMessageSchema).default([]),
  bundleId: ObjectIdString.nullable().default(null),
```

(Remove the `proposedSpec` and `ticketId` lines entirely. `ChatDraftSchema` stays defined — `BundleMember` reuses `SpecInputSchema`, and `ChatDraftSchema` may be removed later if fully unused; leave it for now to keep this task focused.)

- [ ] **Step 6: Fix the ripples so the suite compiles** (these are the type errors Step 7's typecheck will surface — do them now):
  - `src/server/chat.server.ts`:
    - `chatToDTO`: remove `proposedSpec` and `ticketId` from BOTH the `ChatSessionSchema.parse({...})` object and the `ChatSessionDTOSchema.parse({...})` object; add `bundleId: doc.bundleId` to both.
    - `createChatSessionCore` `doc`: replace `proposedSpec: null, ticketId: null` with `bundleId: null`.
    - In `monitorChatTurn`'s `kind==="draft"` branch, the `$set` writes `proposedSpec: draft` — this whole branch is rewritten in Task 4; for NOW, to keep Task 1 green, temporarily replace `proposedSpec: draft` with nothing and instead `failTurn(sessionId, "bundle proposals not wired yet")` before the updateOne, OR leave `draftSpecFromChatCore` and this branch as-is but delete the `proposedSpec` write. Simplest: **delete `draftSpecFromChatCore` and `createTicketFromChatCore` now** (Task 4/5 add their replacements) and make `monitorChatTurn`'s draft branch call `failTurn(sessionId, "draft turns are being replaced by bundles")` + return. (Task 4 replaces it properly.)
  - `src/server/chat.ts`: remove the `draftSpecFromChat` and `createTicketFromChat` exports and their imports (`draftSpecFromChatCore`, `createTicketFromChatCore`); in `ChatSessionDTOSchema` replace `proposedSpec`/`ticketId` with `bundleId: ObjectIdString.nullable()` and change `status` enum to `["active","bundle_locked","abandoned"]`.
  - `src/queries/chat.ts`: remove `useDraftSpecFromChat` and `useCreateTicketFromChat` and their imports.
  - `src/routes/b/$boardSlug/chat/$sessionId.tsx`: remove `useDraftSpecFromChat`/`useCreateTicketFromChat` usage, the `ProposedSpecCard` render + component, and the "Draft spec from this chat" button (Task 8 adds the bundle UI). Leave a bare chat (messages + send) so it compiles.
  - `src/server/chat.dto.test.ts`: update the seeded doc + assertions (`proposedSpec`/`ticketId` → `bundleId`; status default `active`).
  - `src/server/chat.smoke.test.ts`: the draft/create-ticket cases will FAIL to compile (removed fns). Delete those specific cases for now (Task 6's smoke test re-adds bundle coverage). Keep the send/resume/error cases.
  - `src/server/tickets.ts` (TicketDTO): if `TicketDTOSchema` is an explicit `.strict()` schema, add `dependsOn: z.array(ObjectIdString)`; if TicketDTO is derived from `Ticket`, it's automatic — check and adjust. Update any ticket DTO fixture/test that asserts exact keys.

- [ ] **Step 7: Run** — `bunx vitest run src/domain/specBundle.schema.test.ts` → PASS. `bun run typecheck` → exit 0. `bun run test` → all green (count changes due to removed smoke cases; that's expected).

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat(bundle): domain schemas + Ticket.dependsOn; drop single-draft chat path"`

---

## Task 2: SpecBundle DTO + explicit-pick toDTO + collection + regression test

**Files:** Create `src/server/specBundles.server.ts`, `src/server/specBundles.ts`, `src/server/specBundle.dto.test.ts`.

- [ ] **Step 1: Write failing DTO regression test** — `src/server/specBundle.dto.test.ts` (mirror `chat.dto.test.ts` — mock `./db`, seed a FULL doc incl. server-only fields, assert no-throw + no-leak):

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpecBundleDTOSchema } from "./specBundles";

const seeded = {
  _id: { toString: () => "507f1f77bcf86cd799439013" },
  sessionId: "507f1f77bcf86cd799439011",
  boardId: "507f1f77bcf86cd799439012",
  status: "drafting",
  rationale: "split",
  members: [{ localKey: "t1", title: "A", type: "implement", runner: "claude",
    spec: { intent: "x", scope: "", nonGoals: "", acceptance: [], links: [], risk: "low" }, dependsOn: [] }],
  lockedTicketIds: null,
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
  lockedAt: null,
};

vi.mock("./db", () => ({
  ObjectId: class { constructor(public v: string) {} toString() { return this.v; } },
  db: () => Promise.resolve({ collection: () => ({ findOne: () => Promise.resolve(seeded) }) }),
}));

afterEach(() => vi.clearAllMocks());

describe("bundle DTO", () => {
  it("returns a strict DTO with no server-only field leak", async () => {
    const { getBundleCore } = await import("./specBundles.server");
    const dto = await getBundleCore({ bundleId: "507f1f77bcf86cd799439013" });
    expect(SpecBundleDTOSchema.parse(dto)).toEqual(dto);
    expect(dto).not.toHaveProperty("lockedAt");
    expect(dto.members[0].localKey).toBe("t1");
  });
});
```

- [ ] **Step 2: Run it — FAIL** (modules missing).

- [ ] **Step 3: Create `src/server/specBundles.ts`** (DTO + input schemas):

```ts
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { BundleMemberSchema, ObjectIdString, SpecInputSchema, TicketType, RunnerName } from "../domain/schemas";
import { boundary, type ServerResult } from "./result";
import {
  dropBundleMemberCore,
  getBundleCore,
  lockBundleCore,
  reorderBundleCore,
  updateBundleMemberCore,
} from "./specBundles.server";

const timestamp = z.string().datetime();

// Client-facing bundle. Omits server-owned lockedAt/createdAt-internal bookkeeping.
export const SpecBundleDTOSchema = z
  .object({
    _id: ObjectIdString,
    sessionId: ObjectIdString,
    boardId: ObjectIdString,
    status: z.enum(["drafting", "locked"]),
    rationale: z.string(),
    members: z.array(BundleMemberSchema),
    lockedTicketIds: z.array(ObjectIdString).nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type SpecBundleDTO = z.infer<typeof SpecBundleDTOSchema>;

export const BundleRefSchema = z.object({ bundleId: ObjectIdString }).strict();
export type BundleRef = z.infer<typeof BundleRefSchema>;

// A member edit: the fields a human may change on a drafting member.
export const UpdateBundleMemberInputSchema = z
  .object({
    bundleId: ObjectIdString,
    localKey: z.string().min(1),
    patch: z
      .object({
        title: z.string().min(1).optional(),
        type: TicketType.optional(),
        runner: RunnerName.optional(),
        spec: SpecInputSchema.optional(),
        dependsOn: z.array(z.string()).optional(),
      })
      .strict(),
  })
  .strict();
export type UpdateBundleMemberInput = z.infer<typeof UpdateBundleMemberInputSchema>;

export const DropBundleMemberInputSchema = z
  .object({ bundleId: ObjectIdString, localKey: z.string().min(1) })
  .strict();
export type DropBundleMemberInput = z.infer<typeof DropBundleMemberInputSchema>;

export const ReorderBundleInputSchema = z
  .object({ bundleId: ObjectIdString, orderedLocalKeys: z.array(z.string().min(1)).min(1) })
  .strict();
export type ReorderBundleInput = z.infer<typeof ReorderBundleInputSchema>;

const passthrough = (data: unknown): unknown => data;

export const getBundle = createServerFn({ method: "GET" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<SpecBundleDTO>> =>
    boundary(BundleRefSchema, data, getBundleCore),
  );

export const updateBundleMember = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ ok: true }>> =>
    boundary(UpdateBundleMemberInputSchema, data, updateBundleMemberCore),
  );

export const dropBundleMember = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ ok: true }>> =>
    boundary(DropBundleMemberInputSchema, data, dropBundleMemberCore),
  );

export const reorderBundle = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ ok: true }>> =>
    boundary(ReorderBundleInputSchema, data, reorderBundleCore),
  );

export const lockBundle = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ tickets: { ticketId: string; seq: number }[] }>> =>
    boundary(BundleRefSchema, data, lockBundleCore),
  );
```

- [ ] **Step 4: Create `src/server/specBundles.server.ts`** — collection + doc type + `bundleToDTO` (explicit pick) + `getBundleCore` (edit/lock cores are added in Tasks 5–6; stub them minimally here so `specBundles.ts` imports resolve, then flesh out):

```ts
import type { WithId } from "mongodb";
import { SpecBundleSchema, type SpecBundle } from "../domain/schemas";
import { db, ObjectId } from "./db";
import { ServerResultError } from "./result";
import { SpecBundleDTOSchema, type SpecBundleDTO } from "./specBundles";

export type SpecBundleDoc = SpecBundle & {
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
};

export const now = () => new Date().toISOString();

export function specBundles() {
  return db().then((d) => d.collection<SpecBundleDoc>("specBundles"));
}

// Explicit field-pick (never spread) — lockedAt/createdAt-internal never leak.
export function bundleToDTO(doc: WithId<SpecBundleDoc>): SpecBundleDTO {
  const validated = SpecBundleSchema.parse({
    sessionId: doc.sessionId,
    boardId: doc.boardId,
    status: doc.status,
    rationale: doc.rationale,
    members: doc.members,
    lockedTicketIds: doc.lockedTicketIds,
  });
  return SpecBundleDTOSchema.parse({
    _id: doc._id.toString(),
    sessionId: validated.sessionId,
    boardId: validated.boardId,
    status: validated.status,
    rationale: validated.rationale,
    members: validated.members,
    lockedTicketIds: validated.lockedTicketIds,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}

async function loadDraftingBundle(bundleId: string): Promise<WithId<SpecBundleDoc>> {
  const coll = await specBundles();
  const doc = await coll.findOne({ _id: new ObjectId(bundleId) });
  if (!doc) throw new ServerResultError("not_found", `bundle not found: ${bundleId}`);
  return doc;
}

export async function getBundleCore(input: { bundleId: string }): Promise<SpecBundleDTO> {
  return bundleToDTO(await loadDraftingBundle(input.bundleId));
}

// Edit + lock cores are implemented in Tasks 5 & 6.
```

- [ ] **Step 5: Run** — `bunx vitest run src/server/specBundle.dto.test.ts` → PASS. `bun run typecheck` → exit 0 (the edit/lock cores are imported by `specBundles.ts` but not yet defined — **define minimal throwing stubs** for `updateBundleMemberCore`/`dropBundleMemberCore`/`reorderBundleCore`/`lockBundleCore` in `specBundles.server.ts` so imports resolve, e.g. `export async function lockBundleCore(): Promise<never> { throw new ServerResultError("conflict", "not implemented"); }` — Tasks 5–6 replace them).

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(bundle): SpecBundle DTO + explicit-pick + collection (regression-guarded)"`

---

## Task 3: parseBundle + dependency/cycle validator (pure)

**Files:** Modify `src/server/chatResult.ts`; Test `src/server/bundleValidate.test.ts`.

- [ ] **Step 1: Write failing test** — `src/server/bundleValidate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseBundle, validateBundleMembers } from "./chatResult";

const m = (localKey: string, dependsOn: string[] = []) => ({
  localKey, title: "T", type: "implement", runner: "claude",
  spec: { intent: "x", scope: "", nonGoals: "", acceptance: [], links: [], risk: "low" }, dependsOn,
});

describe("validateBundleMembers", () => {
  it("accepts a valid DAG", () => {
    expect(validateBundleMembers([m("t1"), m("t2", ["t1"])])).toBeNull();
  });
  it("rejects empty, dup keys, self-dep, dangling ref, and cycles", () => {
    expect(validateBundleMembers([])).not.toBeNull();
    expect(validateBundleMembers([m("t1"), m("t1")])).not.toBeNull();
    expect(validateBundleMembers([m("t1", ["t1"])])).not.toBeNull();
    expect(validateBundleMembers([m("t1", ["tX"])])).not.toBeNull();
    expect(validateBundleMembers([m("t1", ["t2"]), m("t2", ["t1"])])).not.toBeNull();
  });
});

describe("parseBundle", () => {
  const valid = JSON.stringify({ rationale: "r", members: [m("t1"), m("t2", ["t1"])] });
  it("parses valid + fenced json", () => {
    expect(parseBundle(valid)?.members).toHaveLength(2);
    expect(parseBundle("```json\n" + valid + "\n```")?.members).toHaveLength(2);
  });
  it("returns null on prose or schema-invalid", () => {
    expect(parseBundle("here you go!")).toBeNull();
    expect(parseBundle(`{"rationale":"r"}`)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — FAIL** (`parseBundle`/`validateBundleMembers` missing).

- [ ] **Step 3: Implement** — append to `src/server/chatResult.ts` (add import `SpecBundleProposalSchema, type SpecBundleProposal` from `../domain/schemas`):

```ts
// Structural validity of a bundle's members: unique/non-empty localKeys, every
// dependsOn references an existing key, no self-dependency, no cycles. Returns
// an error message (for turnError) or null when valid. Pure.
export function validateBundleMembers(
  members: { localKey: string; dependsOn: string[] }[],
): string | null {
  if (members.length === 0) return "a bundle needs at least one ticket";
  const keys = new Set<string>();
  for (const m of members) {
    if (!m.localKey || m.localKey.trim() === "") return "every ticket needs a localKey";
    if (keys.has(m.localKey)) return `duplicate localKey: ${m.localKey}`;
    keys.add(m.localKey);
  }
  for (const m of members) {
    for (const dep of m.dependsOn) {
      if (dep === m.localKey) return `${m.localKey} cannot depend on itself`;
      if (!keys.has(dep)) return `${m.localKey} depends on unknown key: ${dep}`;
    }
  }
  const byKey = new Map(members.map((m) => [m.localKey, m.dependsOn]));
  const state = new Map<string, 1 | 2>(); // 1 = visiting, 2 = done
  const visit = (k: string): boolean => {
    const s = state.get(k);
    if (s === 1) return false; // back-edge → cycle
    if (s === 2) return true;
    state.set(k, 1);
    for (const dep of byKey.get(k) ?? []) if (!visit(dep)) return false;
    state.set(k, 2);
    return true;
  };
  for (const m of members) if (!visit(m.localKey)) return `dependency cycle involving ${m.localKey}`;
  return null;
}

// Parse the model's bundle proposal text into a validated SpecBundleProposal.
// Tolerates a ```json fence; schema-invalid → null (fail-closed). Structural
// (dependency/cycle) validation is done separately by validateBundleMembers so
// the caller can surface a specific message.
export function parseBundle(text: string): SpecBundleProposal | null {
  const candidates = [text.trim(), extractFenced(text), extractBraces(text)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = SpecBundleProposalSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      continue;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run — PASS.** `bun run typecheck` → exit 0.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(bundle): parseBundle + dependency/cycle validator (pure, fail-closed)"`

---

## Task 4: Bundle turn — BUNDLE_INSTRUCTION, monitor upsert, proposeBundleFromChat

**Files:** Modify `src/server/chat.server.ts`, `src/server/specBundles.server.ts`, `src/server/chat.ts`, `src/queries/chat.ts`.

- [ ] **Step 1: Add `replaceDraftingBundle` to `src/server/specBundles.server.ts`** (import `type SpecBundleProposal` from `../domain/schemas`):

```ts
// Upsert THE drafting bundle for a session (one per session): replace any
// existing drafting bundle's contents, or insert a new one. Returns the bundle id.
export async function replaceDraftingBundle(
  sessionId: string,
  boardId: string,
  proposal: SpecBundleProposal,
): Promise<string> {
  const coll = await specBundles();
  const at = now();
  const existing = await coll.findOne({ sessionId, status: "drafting" });
  if (existing) {
    await coll.updateOne(
      { _id: existing._id },
      { $set: { rationale: proposal.rationale, members: proposal.members, updatedAt: at } },
    );
    return existing._id.toString();
  }
  const r = await coll.insertOne({
    sessionId, boardId, status: "drafting",
    rationale: proposal.rationale, members: proposal.members,
    lockedTicketIds: null, createdAt: at, updatedAt: at, lockedAt: null,
  });
  return r.insertedId.toString();
}
```

- [ ] **Step 2: Rewrite `monitorChatTurn`'s `kind==="draft"` branch** in `src/server/chat.server.ts` — replace the temporary `failTurn` (from Task 1 Step 6) / old `parseDraft` block with (add imports `parseBundle, validateBundleMembers` from `./chatResult`; `replaceDraftingBundle` from `./specBundles.server`):

```ts
  // kind === "draft": propose a SpecBundle.
  const proposal = parseBundle(parsed.result);
  if (!proposal) {
    await failTurn(sessionId, "the proposal was not valid JSON");
    return;
  }
  const invalid = validateBundleMembers(proposal.members);
  if (invalid) {
    await failTurn(sessionId, `the proposal is invalid: ${invalid}`);
    return;
  }
  const session = await coll.findOne({ _id: new ObjectId(sessionId) });
  if (!session) {
    await failTurn(sessionId, "session vanished mid-turn");
    return;
  }
  const bundleId = await replaceDraftingBundle(sessionId, session.boardId, proposal);
  await coll.updateOne(
    { _id: new ObjectId(sessionId) },
    {
      $set: {
        turnStatus: "idle",
        turnError: null,
        pendingKind: null,
        pendingUserMessageAt: null,
        pid: null,
        bundleId,
        updatedAt: at,
        ...sidPatch,
      },
    },
  );
```

- [ ] **Step 3: Replace the instruction + core** in `src/server/chat.server.ts` — swap `DRAFT_INSTRUCTION` for `BUNDLE_INSTRUCTION` and `draftSpecFromChatCore` (deleted in Task 1) for `proposeBundleFromChatCore`:

```ts
const BUNDLE_INSTRUCTION = [
  "Based on our conversation, decompose the work into one or more tickets.",
  "Respond with ONLY a JSON object, no prose, matching exactly:",
  '{"rationale":string,"members":[{"localKey":string,',
  '"title":string,"type":"research"|"spec"|"implement"|"bugfix"|"review",',
  '"runner":"claude"|"codex",',
  '"spec":{"intent":string,"scope":string,"nonGoals":string,',
  '"acceptance":string[],"links":string[],"risk":"low"|"medium"|"high"},',
  '"dependsOn":string[]}]}',
  "localKey is a short unique id per ticket (t1,t2,…); dependsOn lists the",
  "localKeys this ticket depends on. No cycles. Prefer one ticket unless the",
  "work is genuinely separable.",
].join(" ");

export async function proposeBundleFromChatCore(input: {
  sessionId: string;
}): Promise<{ ok: true }> {
  const coll = await chatSessions();
  const doc = await coll.findOne({ _id: new ObjectId(input.sessionId) });
  if (!doc) {
    throw new ServerResultError("not_found", `chat session not found: ${input.sessionId}`);
  }
  if (doc.status !== "active") {
    throw new ServerResultError("conflict", "this session has already locked its tickets");
  }
  await startChatTurn(input.sessionId, BUNDLE_INSTRUCTION, "draft");
  return { ok: true };
}
```

- [ ] **Step 4: Wire the server fn + hook** — `src/server/chat.ts`: add `proposeBundleFromChat` (reuse `ChatSessionRefSchema`, import `proposeBundleFromChatCore`):

```ts
export const proposeBundleFromChat = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ ok: true }>> =>
    boundary(ChatSessionRefSchema, data, proposeBundleFromChatCore),
  );
```

`src/queries/chat.ts`: add `useProposeBundleFromChat` (mirror the removed `useDraftSpecFromChat`):

```ts
export const useProposeBundleFromChat = createMutation<{ ok: true }, ChatSessionRef>({
  mutationFn: (variables) => proposeBundleFromChat({ data: variables }).then(unwrapResult),
});
```
(add `proposeBundleFromChat` to the import from `../server/chat`.)

- [ ] **Step 5: Verify** — `bun run typecheck` → exit 0. `bun run test` → green (turn execution covered by Task 6 smoke). Commit: `git add -A && git commit -m "feat(bundle): propose turn — BUNDLE_INSTRUCTION, monitor upserts drafting bundle"`

---

## Task 5: Edit cores — update / drop / reorder (drafting-only, re-validated)

**Files:** Modify `src/server/specBundles.server.ts`; Test `src/server/bundleEdit.smoke.test.ts` (real Mongo — mirror `chat.smoke.test.ts` setup, but no fake claude needed: insert a drafting bundle directly, call the cores, assert).

- [ ] **Step 1: Write the failing smoke test** — `src/server/bundleEdit.smoke.test.ts`: insert a drafting bundle with members `[t1, t2(dep t1)]`; `updateBundleMemberCore` changes t1.title → reflected; `dropBundleMemberCore("t1")` → t1 gone AND t2.dependsOn stripped of "t1"; `reorderBundleCore(["t2","t1"])` (on a 2-member set) → members reordered; a non-permutation reorder → throws; editing to introduce a cycle → throws; every core on a `locked` bundle → throws `conflict`. (Full harness code follows the `chat.smoke.test.ts` Mongo bootstrap; assert via `getBundleCore`.)

- [ ] **Step 2: Run — FAIL** (cores are stubs).

- [ ] **Step 3: Implement the three cores** in `src/server/specBundles.server.ts` (import `validateBundleMembers` from `./chatResult`; `BundleMember` type from `../domain/schemas`). Replace the stubs:

```ts
async function requireDrafting(bundleId: string): Promise<WithId<SpecBundleDoc>> {
  const doc = await loadBundle(bundleId); // loadBundle: id-only lookup, no status guard
  if (doc.status !== "drafting") {
    throw new ServerResultError("conflict", "this bundle is locked");
  }
  return doc;
}

// Persist edited members after re-validating structure; fail closed on invalid.
async function saveMembers(bundleId: string, members: BundleMember[]): Promise<void> {
  const invalid = validateBundleMembers(members);
  if (invalid) throw new ServerResultError("conflict", invalid);
  const coll = await specBundles();
  await coll.updateOne(
    { _id: new ObjectId(bundleId), status: "drafting" },
    { $set: { members, updatedAt: now() } },
  );
}

export async function updateBundleMemberCore(input: {
  bundleId: string; localKey: string;
  patch: Partial<Pick<BundleMember, "title" | "type" | "runner" | "spec" | "dependsOn">>;
}): Promise<{ ok: true }> {
  const doc = await requireDrafting(input.bundleId);
  const members = doc.members.map((m) =>
    m.localKey === input.localKey ? { ...m, ...input.patch } : m,
  );
  if (!doc.members.some((m) => m.localKey === input.localKey)) {
    throw new ServerResultError("not_found", `no member: ${input.localKey}`);
  }
  await saveMembers(input.bundleId, members);
  return { ok: true };
}

export async function dropBundleMemberCore(input: {
  bundleId: string; localKey: string;
}): Promise<{ ok: true }> {
  const doc = await requireDrafting(input.bundleId);
  const members = doc.members
    .filter((m) => m.localKey !== input.localKey)
    .map((m) => ({ ...m, dependsOn: m.dependsOn.filter((d) => d !== input.localKey) }));
  await saveMembers(input.bundleId, members); // validator rejects dropping to 0
  return { ok: true };
}

export async function reorderBundleCore(input: {
  bundleId: string; orderedLocalKeys: string[];
}): Promise<{ ok: true }> {
  const doc = await requireDrafting(input.bundleId);
  const current = new Set(doc.members.map((m) => m.localKey));
  const next = new Set(input.orderedLocalKeys);
  if (current.size !== next.size || [...current].some((k) => !next.has(k))) {
    throw new ServerResultError("conflict", "reorder must be a permutation of current keys");
  }
  const byKey = new Map(doc.members.map((m) => [m.localKey, m]));
  const members = input.orderedLocalKeys.map((k) => byKey.get(k)!);
  await saveMembers(input.bundleId, members);
  return { ok: true };
}
```

- [ ] **Step 4: Run — PASS.** `bun run typecheck` → exit 0. Commit: `git add -A && git commit -m "feat(bundle): edit cores — update/drop/reorder, drafting-only + re-validated"`

---

## Task 6: lockBundle — CAS claim, N-ticket create, dependsOn resolve, compensation

**Files:** Modify `src/server/specBundles.server.ts`, `src/server/tickets.server.ts` (add a delete helper); Test `src/server/bundleLock.smoke.test.ts`.

- [ ] **Step 1: Add a delete helper to `src/server/tickets.server.ts`** (exported, for compensation):

```ts
export async function deleteTicketsByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const coll = await tickets();
  await coll.deleteMany({ _id: { $in: ids.map((id) => new ObjectId(id)) } });
}
```
(also export `tickets` is NOT required — the helper encapsulates it. Import `ObjectId` is already present.)

- [ ] **Step 2: Add a dependsOn setter** — the lock sets each created ticket's `dependsOn`. Add to `tickets.server.ts`:

```ts
export async function setTicketDependsOn(ticketId: string, dependsOn: string[]): Promise<void> {
  const coll = await tickets();
  await coll.updateOne(
    { _id: new ObjectId(ticketId) },
    { $set: { dependsOn, updatedAt: now() } },
  );
}
```

- [ ] **Step 3: Write the failing lock smoke test** — `src/server/bundleLock.smoke.test.ts` (real Mongo): insert a board + a drafting bundle `[t1, t2(dep t1), t3]`; `lockBundleCore` → 3 `inbox` tickets exist in members order (seq ascending), t2.dependsOn === [t1.ticketId], bundle.status `locked` + lockedTicketIds aligned, session.status `bundle_locked`; **compensation:** monkeypatch/inject a failure on the 2nd `createTicketCore` (e.g. seed a board whose 2nd member has an invalid field the create rejects, or spy) → assert 0 tickets remain for the board AND bundle back to `drafting` (lockedAt null); locking an already-`locked` bundle → `conflict`.

- [ ] **Step 4: Run — FAIL** (lock stub).

- [ ] **Step 5: Implement `lockBundleCore`** in `src/server/specBundles.server.ts` (import `createTicketCore, deleteTicketsByIds, setTicketDependsOn` from `./tickets.server`; access chatSessions collection via `db()` + `type ChatSessionDoc` from `./chat.server`):

```ts
import { createTicketCore, deleteTicketsByIds, setTicketDependsOn } from "./tickets.server";
import { validateBundleMembers } from "./chatResult";
import type { ChatSessionDoc } from "./chat.server";

export async function lockBundleCore(input: {
  bundleId: string;
}): Promise<{ tickets: { ticketId: string; seq: number }[] }> {
  const coll = await specBundles();
  const doc = await coll.findOne({ _id: new ObjectId(input.bundleId) });
  if (!doc) throw new ServerResultError("not_found", `bundle not found: ${input.bundleId}`);
  if (doc.status !== "drafting") {
    throw new ServerResultError("conflict", "this bundle is already locked");
  }
  const invalid = validateBundleMembers(doc.members);
  if (invalid) throw new ServerResultError("conflict", invalid);

  // CAS claim drafting → locked (serializes concurrent locks).
  const claim = await coll.updateOne(
    { _id: new ObjectId(input.bundleId), status: "drafting" },
    { $set: { status: "locked", lockedAt: now(), updatedAt: now() } },
  );
  if (claim.matchedCount === 0) {
    throw new ServerResultError("conflict", "this bundle is already locked");
  }

  const created: { localKey: string; ticketId: string; seq: number }[] = [];
  try {
    // Pass 1: create tickets in members order.
    for (const m of doc.members) {
      const r = await createTicketCore({
        boardId: doc.boardId, title: m.title, type: m.type, runner: m.runner, spec: m.spec,
      });
      created.push({ localKey: m.localKey, ticketId: r.id, seq: r.seq });
    }
    // Pass 2: resolve localKey → ticketId and set dependsOn.
    const idByKey = new Map(created.map((c) => [c.localKey, c.ticketId]));
    for (const m of doc.members) {
      if (m.dependsOn.length === 0) continue;
      const deps = m.dependsOn.map((k) => idByKey.get(k)!);
      await setTicketDependsOn(idByKey.get(m.localKey)!, deps);
    }
    // Finalize: record lockedTicketIds (members order) + mark the session.
    const lockedTicketIds = doc.members.map((m) => idByKey.get(m.localKey)!);
    await coll.updateOne(
      { _id: new ObjectId(input.bundleId) },
      { $set: { lockedTicketIds, updatedAt: now() } },
    );
    const sessions = (await db()).collection<ChatSessionDoc>("chatSessions");
    await sessions.updateOne(
      { _id: new ObjectId(doc.sessionId) },
      { $set: { status: "bundle_locked", updatedAt: now() } },
    );
    return { tickets: created.map((c) => ({ ticketId: c.ticketId, seq: c.seq })) };
  } catch (error) {
    // Compensation (no transactions): delete every ticket created in this lock,
    // revert the bundle to drafting. All-or-nothing.
    await deleteTicketsByIds(created.map((c) => c.ticketId)).catch(() => undefined);
    await coll.updateOne(
      { _id: new ObjectId(input.bundleId) },
      { $set: { status: "drafting", lockedAt: null, lockedTicketIds: null, updatedAt: now() } },
    );
    throw error instanceof ServerResultError
      ? error
      : new ServerResultError("spawn_failed", "could not create all tickets; rolled back");
  }
}
```

- [ ] **Step 6: Run — PASS.** `bun run typecheck` → exit 0. `bun run build` → succeeds. Commit: `git add -A && git commit -m "feat(bundle): lockBundle — atomic N-ticket create + dependsOn + compensation"`

---

## Task 7: react-query hooks

**Files:** Create `src/queries/specBundles.ts`.

- [ ] **Step 1:** Create `src/queries/specBundles.ts` mirroring `src/queries/chat.ts` (query `useBundle` — no polling; mutations `useUpdateBundleMember`, `useDropBundleMember`, `useReorderBundle`, `useLockBundle`; each `serverFn({data}).then(unwrapResult)`, caller-invalidation, no self-invalidate). Types from `src/server/specBundles.ts`. (Complete code follows the chat-queries shape exactly.)

- [ ] **Step 2:** `bun run typecheck` → exit 0. Commit: `git add -A && git commit -m "feat(bundle): react-query hooks"`

---

## Task 8: UI — Propose tickets + SpecBundle review panel + dependsOn on cards

**Files:** Modify `src/routes/b/$boardSlug/chat/$sessionId.tsx`, `src/components/TicketCard.tsx`, `src/routes/b/$boardSlug/t/$ticketSeq.tsx`.

- [ ] **Step 1:** In the chat route: rename the "Draft spec from this chat" button → **"Propose tickets"** calling `useProposeBundleFromChat` (invalidate `useChatSession` on success). When `session.bundleId` is set, load `useBundle({bundleId})` and render a **`SpecBundleReview`** panel: the `rationale`, then ordered member cards. Each card shows title/type/risk/runner + intent + a **dependsOn chip list** (localKeys), with **edit** (a compact form reusing the ticket-create fields → `useUpdateBundleMember`), **drop** (`useDropBundleMember`), **move up/down** (`useReorderBundle` with the swapped order). A **"Lock all N tickets"** button → `useLockBundle`; on success invalidate `useTickets.getKey({boardId})` + `useChatSession` and `navigate` to `/b/$boardSlug` (board). Inline `role="alert"` errors on every mutation; Lock disabled while pending or when the bundle is empty. Invalidate `useBundle.getKey({bundleId})` after each edit/drop/reorder. (Complete JSX follows the removed `ProposedSpecCard`'s zinc/Tailwind style; reuse `TYPE_LABELS`/`RISK_LABELS`.) Provide the full component code.

- [ ] **Step 2:** `src/components/TicketCard.tsx` + `src/routes/b/$boardSlug/t/$ticketSeq.tsx`: surface `dependsOn` read-only — a small "depends on: #a, #b" line when `ticket.dependsOn.length > 0`. (The DTO carries `dependsOn` from Task 1.)

- [ ] **Step 3:** `bun run typecheck` → exit 0. `bun run build` → succeeds. `bun run test` → green. Commit: `git add -A && git commit -m "feat(bundle): Propose tickets + SpecBundle review panel + dependsOn display"`

---

## Task 9: Final gate

- [ ] **Step 1:** `export PATH="$HOME/.bun/bin:$PATH" && bun run test && bun run typecheck && bun run build && echo GATE_OK`.
- [ ] **Step 2 (manual, optional):** brainstorm → Propose tickets (model returns a 2–3 ticket bundle with a dependency) → edit/reorder/drop → Lock all → the tickets appear on the board with `dependsOn`, each dispatchable through the existing pipeline.

---

## Self-Review

- **Spec coverage:** bundle domain + `Ticket.dependsOn` (T1); DTO explicit-pick + regression (T2); `parseBundle` + cycle validator (T3); propose turn upserts drafting bundle, `proposeBundleFromChat` requires `active` (T4); edit/drop/reorder drafting-only + re-validate (T5); lock = CAS claim + N-ticket create + `dependsOn` resolve + compensation + `session.bundle_locked` (T6); hooks (T7); UI propose/review/lock + `dependsOn` display (T8); gate (T9). All design sections mapped. Removal of the single-draft path is handled in T1 Step 6 with the T4/T6/T8 replacements.
- **Placeholder scan:** T5/T7/T8 describe some code as "follows the existing shape" rather than inlining every line (smoke-harness boilerplate, hook mirror, JSX) — acceptable because the exact templates exist in-repo (`chat.smoke.test.ts`, `src/queries/chat.ts`, the removed `ProposedSpecCard`); the novel logic (cores, validator, lock, compensation) is fully inlined. Implementer must still produce complete code (no TODOs).
- **Type consistency:** `localKey: string` is the bundle-local dependency currency everywhere (member.dependsOn = localKeys); `Ticket.dependsOn = ObjectIdString[]` is the RESOLVED form set only at lock — the two never mix (lock's Pass 2 is the only bridge, via `idByKey`). `SpecBundleProposal` (model output: rationale+members) vs `SpecBundle` (persisted: +sessionId/boardId/status/lockedTicketIds) are distinct and used consistently. `ChatSession` loses `proposedSpec`/`ticketId`, gains `bundleId`, status `ticket_created`→`bundle_locked` — every reference updated in T1 Step 6. `ServerResultError` codes reuse the existing union (`conflict`/`not_found`/`spawn_failed`).
- **Circular imports:** `specBundles.server.ts` type-only-imports `chat.server.ts` (`ChatSessionDoc`) and reaches the chatSessions collection via `db()`; `chat.server.ts` value-imports `replaceDraftingBundle` — one direction. Verified no value cycle.
- **Deferred (not this slice):** specHash/post-lock revisions; dependency-serialized dispatch; overlapping-scope serialization; EventJournal; multi-bundle history.
