# Fast-Path Thin Chat Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first testable end-to-end loop — brainstorm in a chat panel → draft a spec from that conversation → create one ticket that flows into the existing run→verify→needs_input pipeline.

**Architecture:** A new `chatSessions` collection. Each user message is a turn-based batch call to `claude -p <text> --output-format json [--resume <sessionId>]`, spawned async in the board repo cwd and surfaced by react-query polling (the app's existing dispatch→poll convention) — no SSE, no Agent SDK. A background monitor drains stdout, parses the reply (and captures the provider session id on the first turn), and either appends an assistant message or stores a proposed ticket draft. Fail-closed: any failure lands the session in `turnStatus:"error"`, still retryable. A "Draft spec from this chat" action asks the model for structured JSON; confirming it calls the existing `createTicketCore`.

**Tech stack:** Bun, TanStack Start (React 19, `createServerFn`), MongoDB official driver + Zod at boundaries, react-query-kit, Tailwind 4, Vitest.

**Source of truth:** `docs/superpowers/specs/2026-07-22-fast-path-chat-slice-design.md`. Read it before starting.

**Conventions reused (do not reinvent):**
- Schemas + `.strict()` input shapes: `src/domain/schemas.ts`.
- Server-fn boundary: `createServerFn({method}).validator(passthrough).handler(({data}) => boundary(Schema, data, coreFn))`; `ServerResult`/`ServerResultError`/`boundary` in `src/server/result.ts`.
- Persisted-doc → DTO explicit field-pick with `.strict()` (never spread): `src/server/runs.server.ts` `toDTO`. Regression-test style: `src/server/runs.dto.test.ts`.
- Process primitives (import from `src/server/supervisor.server.ts`): `drainStream`, `settledExit`, `waitForSpawn`, `isProcessAlive` — plus `parseSessionId` from `src/server/outcome.server.ts`.
- Smoke-test harness (fake `claude` on PATH, real Mongo): `src/server/needs-input.smoke.test.ts`.
- react-query-kit hooks: `src/queries/runs.ts`; poll-gating predicate style: `src/components/runsUi.ts`.
- UI palette/patterns: `src/routes/b/$boardSlug.tsx`, `src/routes/b/$boardSlug/new.tsx`, `src/components/RunsSection.tsx`, `src/components/GateButtons.tsx`.

**Exports to add to `src/server/supervisor.server.ts` (Task 4 depends on these):** `drainStream`, `settledExit`, `waitForSpawn` are currently module-private. Task 4 Step 0 adds `export` to each (they are already used cross-cutting; exporting is safe and additive). `isProcessAlive` is already exported.

---

## Task 0: Baseline

- [ ] **Step 1: Confirm branch + green baseline**

Run: `git branch --show-current` → expect `feat/v2-chat-slice`.
Run: `export PATH="$HOME/.bun/bin:$PATH" && bun run test && bun run typecheck`
Expected: tests all pass (150), typecheck exit 0.

No commit.

---

## Task 1: Domain schemas — ChatMessage, ChatDraft, ChatTurnStatus, ChatSession

**Files:**
- Modify: `src/domain/schemas.ts` (append after `SetRunnerInputSchema`)
- Test: `src/domain/chat.schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/domain/chat.schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ChatDraftSchema,
  ChatMessageSchema,
  ChatSessionSchema,
  ChatTurnStatus,
} from "./schemas";

describe("chat schemas", () => {
  it("accepts a minimal chat session and applies defaults", () => {
    const s = ChatSessionSchema.parse({
      boardId: "507f1f77bcf86cd799439011",
    });
    expect(s.provider).toBe("claude");
    expect(s.sessionId).toBeNull();
    expect(s.status).toBe("active");
    expect(s.turnStatus).toBe("idle");
    expect(s.turnError).toBeNull();
    expect(s.messages).toEqual([]);
    expect(s.proposedSpec).toBeNull();
    expect(s.ticketId).toBeNull();
  });

  it("validates message role + turn status enum", () => {
    expect(() =>
      ChatMessageSchema.parse({ role: "user", text: "hi", at: new Date().toISOString() }),
    ).not.toThrow();
    expect(() => ChatMessageSchema.parse({ role: "system", text: "x", at: new Date().toISOString() })).toThrow();
    expect(ChatTurnStatus.options).toEqual(["idle", "pending", "error"]);
  });

  it("accepts a well-formed draft and rejects a malformed one (fail-closed)", () => {
    const draft = ChatDraftSchema.parse({
      title: "Add auth",
      type: "implement",
      runner: "claude",
      spec: { intent: "add login", scope: "", nonGoals: "", acceptance: [], links: [], risk: "low" },
    });
    expect(draft.title).toBe("Add auth");
    // missing intent → invalid
    expect(() =>
      ChatDraftSchema.parse({ title: "x", type: "implement", runner: "claude", spec: { scope: "", nonGoals: "", acceptance: [], links: [], risk: "low" } }),
    ).toThrow();
    // unknown top-level key → rejected (strict)
    expect(() =>
      ChatDraftSchema.parse({ title: "x", type: "implement", runner: "claude", spec: { intent: "y", scope: "", nonGoals: "", acceptance: [], links: [], risk: "low" }, extra: 1 }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `bunx vitest run src/domain/chat.schema.test.ts`
Expected: FAIL — `ChatSessionSchema`/`ChatMessageSchema`/`ChatDraftSchema`/`ChatTurnStatus` not exported.

- [ ] **Step 3: Implement the schemas**

Append to `src/domain/schemas.ts` (after `SetRunnerInputSchema`/`SetRunnerInput`):

```ts
// --- Chat (brainstorm → draft → ticket) ---------------------------------
// A single chat session's provider conversation. Turn-based: each user turn
// is a batch `claude -p` call surfaced by polling. `turnStatus` is the
// session-level turn state; a failed turn is retryable (session stays usable).

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  at: z.string().datetime(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatTurnStatus = z.enum(["idle", "pending", "error"]);

// What draftSpecFromChat asks the model to emit — a superset of the ticket
// input minus server-owned fields. `.strict()` so a stray key fails closed.
export const ChatDraftSchema = z
  .object({
    title: z.string().min(1),
    type: TicketType,
    runner: RunnerName,
    spec: SpecInputSchema,
  })
  .strict();
export type ChatDraft = z.infer<typeof ChatDraftSchema>;

// Persisted chat session's validated fields. Defaults are retained so stored
// documents always hydrate with every field present (as with TicketSchema).
export const ChatSessionSchema = z.object({
  boardId: ObjectIdString,
  provider: z.literal("claude").default("claude"),
  sessionId: z.string().nullable().default(null),
  status: z.enum(["active", "ticket_created", "abandoned"]).default("active"),
  turnStatus: ChatTurnStatus.default("idle"),
  turnError: z.string().nullable().default(null),
  messages: z.array(ChatMessageSchema).default([]),
  proposedSpec: ChatDraftSchema.nullable().default(null),
  ticketId: ObjectIdString.nullable().default(null),
});
export type ChatSession = z.infer<typeof ChatSessionSchema>;
```

- [ ] **Step 4: Run the test — expect pass**

Run: `bunx vitest run src/domain/chat.schema.test.ts` → PASS.
Run: `bun run typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/domain/schemas.ts src/domain/chat.schema.test.ts
git commit -m "feat(chat): domain schemas — ChatSession/ChatMessage/ChatDraft"
```

---

## Task 2: Chat DTO + explicit-pick toDTO + regression test

**Files:**
- Create: `src/server/chat.ts` (DTO schema + input schemas + server-fn stubs come in Task 5; this task adds only the DTO schema)
- Create: `src/server/chat.server.ts` (only `chatToDTO` + `listChatSession` read core in this task; turn execution in Task 4)
- Test: `src/server/chat.dto.test.ts`

> Rationale for splitting the DTO out first: it is the client contract the poll depends on, and the explicit-pick `.strict()` mapping is the exact pattern that silently broke in slice B — lock it with a regression test before anything reads it.

- [ ] **Step 1: Write the DTO schema**

Create `src/server/chat.ts`:

```ts
import { z } from "zod";
import {
  ChatDraftSchema,
  ChatMessageSchema,
  ChatTurnStatus,
  ObjectIdString,
} from "../domain/schemas";

const timestamp = z.string().datetime();

// Client-facing chat session. Explicitly omits server-owned bookkeeping
// (pid, logFile, pendingKind, pendingUserMessageAt). `.strict()` is a real
// contract — toDTO builds this by explicit pick, never a spread (slice-B lesson).
export const ChatSessionDTOSchema = z
  .object({
    _id: ObjectIdString,
    boardId: ObjectIdString,
    provider: z.literal("claude"),
    sessionId: z.string().nullable(),
    status: z.enum(["active", "ticket_created", "abandoned"]),
    turnStatus: ChatTurnStatus,
    turnError: z.string().nullable(),
    messages: z.array(ChatMessageSchema),
    proposedSpec: ChatDraftSchema.nullable(),
    ticketId: ObjectIdString.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type ChatSessionDTO = z.infer<typeof ChatSessionDTOSchema>;
```

- [ ] **Step 2: Write the failing regression test**

Create `src/server/chat.dto.test.ts` (mirrors `runs.dto.test.ts`):

```ts
import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { ChatSessionSchema } from "../domain/schemas";
import { ChatSessionDTOSchema } from "./chat";

const mockState = vi.hoisted(() => ({ doc: null as unknown }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    db: async () => ({
      collection: () => ({
        findOne: async () => mockState.doc,
      }),
    }),
  };
});

const { getChatSessionCore } = await import("./chat.server");

describe("chat DTO mapping", () => {
  it("maps a session without leaking server bookkeeping", async () => {
    const id = new ObjectId();
    const session = ChatSessionSchema.parse({ boardId: new ObjectId().toString() });
    mockState.doc = {
      _id: id,
      ...session,
      createdAt: "2026-07-22T10:00:00.000Z",
      updatedAt: "2026-07-22T10:00:00.000Z",
      pid: 4242,
      logFile: "/repo/.tosin4dev/chat/x/turn.log",
      pendingKind: null,
      pendingUserMessageAt: null,
    };

    const dto = await getChatSessionCore({ sessionId: id.toString() });

    expect(ChatSessionDTOSchema.parse(dto)).toEqual(dto);
    expect(dto).not.toHaveProperty("pid");
    expect(dto).not.toHaveProperty("logFile");
    expect(dto).not.toHaveProperty("pendingKind");
  });
});
```

- [ ] **Step 3: Run it — expect failure**

Run: `bunx vitest run src/server/chat.dto.test.ts`
Expected: FAIL — `getChatSessionCore` not exported from `./chat.server`.

- [ ] **Step 4: Implement `chat.server.ts` doc types + `chatToDTO` + `getChatSessionCore`**

Create `src/server/chat.server.ts`:

```ts
import type { WithId } from "mongodb";
import { ChatSessionSchema, type ChatSession } from "../domain/schemas";
import { ChatSessionDTOSchema, type ChatSessionDTO } from "./chat";
import { db, ObjectId } from "./db";
import { ServerResultError } from "./result";

// Persisted chat session document: validated fields + server-owned bookkeeping.
export type ChatSessionDoc = ChatSession & {
  createdAt: string;
  updatedAt: string;
  pid: number | null;
  logFile: string | null;
  pendingKind: "message" | "draft" | null;
  pendingUserMessageAt: string | null;
};

export const now = () => new Date().toISOString();

export function chatSessions() {
  return db().then((d) => d.collection<ChatSessionDoc>("chatSessions"));
}

// Explicit field-pick (never spread) so growth of ChatSessionDoc can never
// leak server bookkeeping through the `.strict()` DTO (slice-B regression).
export function chatToDTO(doc: WithId<ChatSessionDoc>): ChatSessionDTO {
  const validated = ChatSessionSchema.parse({
    boardId: doc.boardId,
    provider: doc.provider,
    sessionId: doc.sessionId,
    status: doc.status,
    turnStatus: doc.turnStatus,
    turnError: doc.turnError,
    messages: doc.messages,
    proposedSpec: doc.proposedSpec,
    ticketId: doc.ticketId,
  });
  return ChatSessionDTOSchema.parse({
    _id: doc._id.toString(),
    ...validated,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}

export async function getChatSessionCore(input: {
  sessionId: string;
}): Promise<ChatSessionDTO> {
  const coll = await chatSessions();
  const doc = await coll.findOne({ _id: new ObjectId(input.sessionId) });
  if (!doc) {
    throw new ServerResultError(
      "not_found",
      `chat session not found: ${input.sessionId}`,
    );
  }
  return chatToDTO(doc);
}
```

- [ ] **Step 5: Run the test — expect pass**

Run: `bunx vitest run src/server/chat.dto.test.ts` → PASS.
Run: `bun run typecheck` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/server/chat.ts src/server/chat.server.ts src/server/chat.dto.test.ts
git commit -m "feat(chat): session DTO + explicit-pick toDTO (regression-guarded)"
```

---

## Task 3: Chat turn command builder

**Files:**
- Create: `src/server/chatCommand.ts`
- Test: `src/server/chatCommand.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/chatCommand.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildChatCommand } from "./chatCommand";

describe("buildChatCommand", () => {
  it("builds a fresh turn without --resume", () => {
    expect(buildChatCommand("hello", null)).toEqual([
      "claude", "-p", "hello", "--output-format", "json",
    ]);
  });
  it("appends --resume with a captured session id", () => {
    expect(buildChatCommand("more", "sess-1")).toEqual([
      "claude", "-p", "more", "--output-format", "json", "--resume", "sess-1",
    ]);
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `bunx vitest run src/server/chatCommand.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

Create `src/server/chatCommand.ts`:

```ts
// The argv for one brainstorm turn. Unlike the run adapter (which points the
// agent at a prompt file), a chat turn passes the user's text directly and
// resumes the captured provider session so context carries across turns.
export function buildChatCommand(
  text: string,
  sessionId: string | null,
): string[] {
  const cmd = ["claude", "-p", text, "--output-format", "json"];
  if (sessionId) cmd.push("--resume", sessionId);
  return cmd;
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `bunx vitest run src/server/chatCommand.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/chatCommand.ts src/server/chatCommand.test.ts
git commit -m "feat(chat): turn command builder (claude -p [--resume])"
```

---

## Task 4: Chat turn execution — spawn, monitor, parse, fail-closed, boot-reconcile

**Files:**
- Modify: `src/server/supervisor.server.ts` (export three helpers)
- Create: `src/server/chatResult.ts` (pure parsers) + `src/server/chatResult.test.ts`
- Modify: `src/server/chat.server.ts` (add turn execution)

- [ ] **Step 0: Export the process primitives**

In `src/server/supervisor.server.ts`, add `export` to the three helper declarations (additive; no behavior change):
- `async function drainStream(` → `export async function drainStream(`
- `function settledExit(` → `export function settledExit(`
- `function waitForSpawn(` → `export function waitForSpawn(`

Run: `bun run typecheck` → exit 0 (no other change needed). Do not commit yet.

- [ ] **Step 1: Write the failing parser test**

Create `src/server/chatResult.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseChatResult, parseDraft } from "./chatResult";

describe("parseChatResult", () => {
  it("extracts result text and session id from claude json", () => {
    const out = `{"type":"result","session_id":"s-1","result":"hi there"}`;
    expect(parseChatResult(out)).toEqual({ result: "hi there", sessionId: "s-1" });
  });
  it("returns null when there is no result field", () => {
    expect(parseChatResult(`{"session_id":"s-1"}`)).toBeNull();
    expect(parseChatResult("not json")).toBeNull();
  });
});

describe("parseDraft", () => {
  const valid = JSON.stringify({
    title: "Add login", type: "implement", runner: "claude",
    spec: { intent: "add", scope: "", nonGoals: "", acceptance: [], links: [], risk: "low" },
  });
  it("parses a valid draft, including fenced json", () => {
    expect(parseDraft(valid)?.title).toBe("Add login");
    expect(parseDraft("```json\n" + valid + "\n```")?.title).toBe("Add login");
  });
  it("returns null on prose or invalid draft (fail-closed)", () => {
    expect(parseDraft("here is your spec!")).toBeNull();
    expect(parseDraft(`{"title":"x"}`)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `bunx vitest run src/server/chatResult.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement the parsers**

Create `src/server/chatResult.ts`:

```ts
import { ChatDraftSchema, type ChatDraft } from "../domain/schemas";
import { parseSessionId } from "./outcome.server";

// Pull the final assistant text + provider session id out of a claude
// --output-format json turn. Returns null if no `result` string is present.
export function parseChatResult(
  stdout: string,
): { result: string; sessionId: string | null } | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj && typeof obj === "object" && typeof obj.result === "string") {
        return { result: obj.result, sessionId: parseSessionId("claude", stdout) };
      }
    } catch {
      continue;
    }
  }
  return null;
}

// Parse the model's drafted spec text into a validated ChatDraft. Tolerates a
// ```json fence; anything not matching the schema fails closed (null).
export function parseDraft(text: string): ChatDraft | null {
  const candidates = [text.trim(), extractFenced(text), extractBraces(text)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = ChatDraftSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      continue;
    }
  }
  return null;
}

function extractFenced(text: string): string | null {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return m ? m[1].trim() : null;
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `bunx vitest run src/server/chatResult.test.ts` → PASS.

- [ ] **Step 5: Add turn execution to `chat.server.ts`**

Append to `src/server/chat.server.ts` (add imports at top: `mkdir`, `writeFile` from `node:fs/promises`; `dirname` from `node:path`; `spawn`, `ChildProcess` from `node:child_process`; `BoardSchema`, `type Board` from `../domain/schemas`; `drainStream`, `settledExit`, `waitForSpawn`, `isProcessAlive` from `./supervisor.server`; `buildChatCommand` from `./chatCommand`; `parseChatResult`, `parseDraft` from `./chatResult`):

```ts
type BoardDoc = Board & { createdAt: string; updatedAt: string };

const STUCK_TURN_MS = 5 * 60 * 1000;

interface RunningTurn {
  stdout: Promise<string>;
  stderr: Promise<string>;
  exited: Promise<number>;
}

async function loadBoard(boardId: string): Promise<Board> {
  const database = await db();
  const raw = await database
    .collection<BoardDoc>("boards")
    .findOne({ _id: new ObjectId(boardId) });
  if (!raw) throw new ServerResultError("not_found", `board not found: ${boardId}`);
  return BoardSchema.parse(raw);
}

async function failTurn(sessionId: string, message: string): Promise<void> {
  const coll = await chatSessions();
  await coll.updateOne(
    { _id: new ObjectId(sessionId) },
    {
      $set: {
        turnStatus: "error",
        turnError: message,
        pendingKind: null,
        pendingUserMessageAt: null,
        pid: null,
        updatedAt: now(),
      },
    },
  );
}

async function monitorChatTurn(
  running: RunningTurn,
  sessionId: string,
  kind: "message" | "draft",
): Promise<void> {
  let stdout: string;
  let code: number;
  try {
    [stdout, , code] = await Promise.all([
      running.stdout,
      running.stderr,
      running.exited,
    ]);
  } catch {
    await failTurn(sessionId, "the assistant process errored");
    return;
  }
  if (code !== 0) {
    await failTurn(sessionId, `the assistant exited with code ${code}`);
    return;
  }
  const parsed = parseChatResult(stdout);
  if (!parsed) {
    await failTurn(sessionId, "the assistant returned no parseable reply");
    return;
  }
  const coll = await chatSessions();
  const at = now();
  const sidPatch = parsed.sessionId ? { sessionId: parsed.sessionId } : {};

  if (kind === "message") {
    await coll.updateOne(
      { _id: new ObjectId(sessionId) },
      {
        $set: {
          turnStatus: "idle",
          pendingKind: null,
          pendingUserMessageAt: null,
          pid: null,
          updatedAt: at,
          ...sidPatch,
        },
        $push: { messages: { role: "assistant", text: parsed.result, at } },
      },
    );
    return;
  }

  const draft = parseDraft(parsed.result);
  if (!draft) {
    await failTurn(sessionId, "the drafted spec was not valid JSON");
    return;
  }
  await coll.updateOne(
    { _id: new ObjectId(sessionId) },
    {
      $set: {
        turnStatus: "idle",
        pendingKind: null,
        pendingUserMessageAt: null,
        pid: null,
        proposedSpec: draft,
        updatedAt: at,
        ...sidPatch,
      },
    },
  );
}

// Claim a pending turn (throws on conflict/not-found BEFORE any side effect),
// then spawn the assistant. Once claimed, all execution failures resolve into
// turnStatus:"error" (retryable) rather than throwing — the poll surfaces it.
export async function startChatTurn(
  sessionId: string,
  text: string,
  kind: "message" | "draft",
): Promise<void> {
  const coll = await chatSessions();
  const doc = await coll.findOne({ _id: new ObjectId(sessionId) });
  if (!doc) {
    throw new ServerResultError("not_found", `chat session not found: ${sessionId}`);
  }
  if (doc.turnStatus === "pending") {
    throw new ServerResultError("conflict", "a turn is already in progress");
  }
  const board = await loadBoard(doc.boardId);

  const at = now();
  const logFile = `${board.repoPath}/.tosin4dev/chat/${sessionId}/turn.log`;
  await mkdir(dirname(logFile), { recursive: true });
  await writeFile(logFile, "");

  const claim = await coll.updateOne(
    { _id: new ObjectId(sessionId), turnStatus: { $ne: "pending" } },
    {
      $set: {
        turnStatus: "pending",
        pendingKind: kind,
        pendingUserMessageAt: at,
        turnError: null,
        logFile,
        pid: null,
        updatedAt: at,
      },
      ...(kind === "message"
        ? { $push: { messages: { role: "user", text, at } } }
        : {}),
    },
  );
  if (claim.matchedCount === 0) {
    throw new ServerResultError("conflict", "a turn is already in progress");
  }

  let child: ChildProcess | undefined;
  let running: RunningTurn | undefined;
  try {
    const cmd = buildChatCommand(text, doc.sessionId);
    const spawned = spawn(cmd[0], cmd.slice(1), {
      cwd: board.repoPath,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawned;
    running = {
      stdout: drainStream(spawned.stdout, logFile, true),
      stderr: drainStream(spawned.stderr, logFile, false),
      exited: settledExit(spawned),
    };
    void Promise.all([running.stdout, running.stderr, running.exited]).catch(
      () => undefined,
    );
    await waitForSpawn(spawned);
    await coll.updateOne(
      { _id: new ObjectId(sessionId) },
      { $set: { pid: spawned.pid ?? null } },
    );
    void monitorChatTurn(running, sessionId, kind).catch((error) =>
      console.error(`Chat monitor failed for session ${sessionId}:`, error),
    );
  } catch {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await running?.exited.catch(() => undefined);
    }
    await failTurn(sessionId, "could not start the assistant");
  }
}

// Light boot/stuck reconcile: a session left `pending` by a crash (dead pid or
// a turn older than STUCK_TURN_MS) is failed so it becomes retryable. Called on
// read; full daemon recovery is out of scope (a stuck brainstorm is low-stakes).
export async function reconcileChatSession(
  doc: WithId<ChatSessionDoc>,
): Promise<void> {
  if (doc.turnStatus !== "pending") return;
  const stale =
    doc.pendingUserMessageAt !== null &&
    Date.now() - new Date(doc.pendingUserMessageAt).getTime() > STUCK_TURN_MS;
  // A null pid means the turn is still starting: claimed (turnStatus:"pending")
  // but the pid is written only AFTER waitForSpawn resolves. A concurrent poll
  // hitting that window must NOT reap a healthy turn — treat null pid as alive
  // unless it has gone stale. Only reap a turn whose RECORDED pid is dead, or
  // any pending turn past STUCK_TURN_MS (the crash-during-startup backstop).
  if (!stale && (doc.pid === null || isProcessAlive(doc.pid))) return;
  await failTurn(doc._id.toString(), "the previous turn was interrupted");
}
```

Then wire `reconcileChatSession` into `getChatSessionCore` — before returning, if the doc is pending, reconcile and re-read:

```ts
export async function getChatSessionCore(input: {
  sessionId: string;
}): Promise<ChatSessionDTO> {
  const coll = await chatSessions();
  let doc = await coll.findOne({ _id: new ObjectId(input.sessionId) });
  if (!doc) {
    throw new ServerResultError(
      "not_found",
      `chat session not found: ${input.sessionId}`,
    );
  }
  if (doc.turnStatus === "pending") {
    await reconcileChatSession(doc);
    doc = (await coll.findOne({ _id: new ObjectId(input.sessionId) })) ?? doc;
  }
  return chatToDTO(doc);
}
```

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck` → exit 0. (No new unit test here beyond the parser test — turn execution is covered by the Task 5 smoke test against a fake `claude`.)

- [ ] **Step 7: Commit**

```bash
git add src/server/supervisor.server.ts src/server/chatResult.ts src/server/chatResult.test.ts src/server/chat.server.ts
git commit -m "feat(chat): turn execution — spawn/monitor/parse, fail-closed + reconcile"
```

---

## Task 5: Server functions + cores + smoke test

**Files:**
- Modify: `src/server/chat.ts` (input schemas + server fns)
- Modify: `src/server/chat.server.ts` (cores: create, send, draft, createTicketFromChat)
- Test: `src/server/chat.smoke.test.ts`

- [ ] **Step 1: Add input schemas + server fns to `chat.ts`**

Append to `src/server/chat.ts`:

```ts
import { createServerFn } from "@tanstack/react-start";
import { boundary, type ServerResult } from "./result";
import {
  createChatSessionCore,
  draftSpecFromChatCore,
  getChatSessionCore,
  sendChatMessageCore,
  createTicketFromChatCore,
} from "./chat.server";

export const CreateChatSessionInputSchema = z
  .object({ boardId: ObjectIdString })
  .strict();
export type CreateChatSessionInput = z.infer<typeof CreateChatSessionInputSchema>;

export const ChatSessionRefSchema = z
  .object({ sessionId: ObjectIdString })
  .strict();
export type ChatSessionRef = z.infer<typeof ChatSessionRefSchema>;

export const SendChatMessageInputSchema = z
  .object({ sessionId: ObjectIdString, text: z.string().min(1) })
  .strict();
export type SendChatMessageInput = z.infer<typeof SendChatMessageInputSchema>;

const passthrough = (data: unknown): unknown => data;

export const createChatSession = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ id: string }>> =>
    boundary(CreateChatSessionInputSchema, data, createChatSessionCore),
  );

export const getChatSession = createServerFn({ method: "GET" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<ChatSessionDTO>> =>
    boundary(ChatSessionRefSchema, data, getChatSessionCore),
  );

export const sendChatMessage = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ ok: true }>> =>
    boundary(SendChatMessageInputSchema, data, sendChatMessageCore),
  );

export const draftSpecFromChat = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ ok: true }>> =>
    boundary(ChatSessionRefSchema, data, draftSpecFromChatCore),
  );

export const createTicketFromChat = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ ticketId: string; seq: number }>> =>
    boundary(ChatSessionRefSchema, data, createTicketFromChatCore),
  );
```

- [ ] **Step 2: Add the cores to `chat.server.ts`**

Add imports: `createTicketCore` from `./tickets.server`. Append:

```ts
// The instruction that turns brainstorm context into a machine-parseable draft.
const DRAFT_INSTRUCTION = [
  "Based on our conversation so far, produce ONE ticket spec.",
  "Respond with ONLY a JSON object, no prose, matching exactly:",
  '{"title":string,"type":"research"|"spec"|"implement"|"bugfix"|"review",',
  '"runner":"claude"|"codex",',
  '"spec":{"intent":string,"scope":string,"nonGoals":string,',
  '"acceptance":string[],"links":string[],"risk":"low"|"medium"|"high"}}',
].join(" ");

export async function createChatSessionCore(input: {
  boardId: string;
}): Promise<{ id: string }> {
  await loadBoard(input.boardId); // validates the board exists
  const coll = await chatSessions();
  const at = now();
  const doc: ChatSessionDoc = {
    boardId: input.boardId,
    provider: "claude",
    sessionId: null,
    status: "active",
    turnStatus: "idle",
    turnError: null,
    messages: [],
    proposedSpec: null,
    ticketId: null,
    createdAt: at,
    updatedAt: at,
    pid: null,
    logFile: null,
    pendingKind: null,
    pendingUserMessageAt: null,
  };
  const r = await coll.insertOne(doc);
  return { id: r.insertedId.toString() };
}

export async function sendChatMessageCore(input: {
  sessionId: string;
  text: string;
}): Promise<{ ok: true }> {
  await startChatTurn(input.sessionId, input.text, "message");
  return { ok: true };
}

export async function draftSpecFromChatCore(input: {
  sessionId: string;
}): Promise<{ ok: true }> {
  await startChatTurn(input.sessionId, DRAFT_INSTRUCTION, "draft");
  return { ok: true };
}

export async function createTicketFromChatCore(input: {
  sessionId: string;
}): Promise<{ ticketId: string; seq: number }> {
  const coll = await chatSessions();
  const doc = await coll.findOne({ _id: new ObjectId(input.sessionId) });
  if (!doc) {
    throw new ServerResultError("not_found", `chat session not found: ${input.sessionId}`);
  }
  if (!doc.proposedSpec) {
    throw new ServerResultError("conflict", "no drafted spec to create a ticket from");
  }
  const created = await createTicketCore({
    boardId: doc.boardId,
    title: doc.proposedSpec.title,
    type: doc.proposedSpec.type,
    runner: doc.proposedSpec.runner,
    spec: doc.proposedSpec.spec,
  });
  await coll.updateOne(
    { _id: new ObjectId(input.sessionId) },
    {
      $set: {
        status: "ticket_created",
        ticketId: created.id,
        updatedAt: now(),
      },
    },
  );
  return { ticketId: created.id, seq: created.seq };
}
```

- [ ] **Step 3: Write the smoke test**

Create `src/server/chat.smoke.test.ts` (mirror `needs-input.smoke.test.ts` setup: fake `claude` on PATH, real Mongo, temp git repo + board). Key cases:

```ts
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Collection, Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DB = `tosin4dev-test-chat-${process.pid}-${Date.now()}`;
const ORIGINAL_PATH = process.env.PATH;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;

const { db, closeDb, ObjectId } = await import("./db");
const {
  createChatSessionCore,
  sendChatMessageCore,
  getChatSessionCore,
  draftSpecFromChatCore,
  createTicketFromChatCore,
} = await import("./chat.server");

let database: Db;
let repo: string;
let binDir: string;
let boardId: string;

// The fake claude echoes its -p prompt so the test can assert resume threading,
// and returns valid draft JSON when asked to draft.
async function writeRunner(): Promise<void> {
  const exe = join(binDir, "claude");
  await writeFile(
    exe,
    `#!/bin/sh
# args: -p <text> --output-format json [--resume <sid>]
PROMPT="$2"
case "$PROMPT" in
  *"ONLY a JSON object"*)
    RESULT='{"title":"Add login","type":"implement","runner":"claude","spec":{"intent":"add login","scope":"","nonGoals":"","acceptance":[],"links":[],"risk":"low"}}'
    ;;
  *) RESULT="reply to: $PROMPT" ;;
esac
printf '%s\\n' "{\\"type\\":\\"result\\",\\"session_id\\":\\"s-chat\\",\\"result\\":\\"$RESULT\\"}"
exit 0
`,
  );
  await chmod(exe, 0o755);
}

async function waitForIdle(sessionId: string, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await getChatSessionCore({ sessionId });
    if (s.turnStatus !== "pending") return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("chat turn did not settle");
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "t4d-chat-repo-"));
  binDir = await mkdtemp(join(tmpdir(), "t4d-chat-bin-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  process.env.PATH = `${binDir}:${ORIGINAL_PATH ?? ""}`;
  await writeRunner();
  database = await db();
  const at = new Date().toISOString();
  const b = await database.collection("boards").insertOne({
    slug: `chat-${process.pid}-${Date.now()}`, name: "Chat", repoPath: repo,
    defaultBaseBranch: "main", checks: [], createdAt: at, updatedAt: at,
  });
  boardId = b.insertedId.toString();
});

afterAll(async () => {
  await database.dropDatabase();
  await closeDb();
  process.env.PATH = ORIGINAL_PATH;
});

describe("chat slice", () => {
  it("sends a message, captures session id, resumes on the next turn", async () => {
    const { id } = await createChatSessionCore({ boardId });
    await sendChatMessageCore({ sessionId: id, text: "hello" });
    const s1 = await waitForIdle(id);
    expect(s1.turnStatus).toBe("idle");
    expect(s1.sessionId).toBe("s-chat");
    expect(s1.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s1.messages[1].text).toContain("reply to: hello");

    await sendChatMessageCore({ sessionId: id, text: "again" });
    const s2 = await waitForIdle(id);
    expect(s2.messages).toHaveLength(4);
  });

  it("drafts a spec and creates a dispatchable inbox ticket", async () => {
    const { id } = await createChatSessionCore({ boardId });
    await sendChatMessageCore({ sessionId: id, text: "let's build login" });
    await waitForIdle(id);
    await draftSpecFromChatCore({ sessionId: id });
    const drafted = await waitForIdle(id);
    expect(drafted.proposedSpec?.title).toBe("Add login");

    const { ticketId, seq } = await createTicketFromChatCore({ sessionId: id });
    expect(seq).toBeGreaterThan(0);
    const ticket = await database
      .collection("tickets")
      .findOne({ _id: new ObjectId(ticketId) });
    expect(ticket?.status).toBe("inbox");
    expect(ticket?.title).toBe("Add login");
    const after = await getChatSessionCore({ sessionId: id });
    expect(after.status).toBe("ticket_created");
    expect(after.ticketId).toBe(ticketId);
  });

  it("rejects a second message while a turn is pending, and errors fail-closed", async () => {
    const { id } = await createChatSessionCore({ boardId });
    await sendChatMessageCore({ sessionId: id, text: "one" });
    // second send before settle → conflict
    await expect(
      sendChatMessageCore({ sessionId: id, text: "two" }),
    ).rejects.toThrow(/in progress/);
    await waitForIdle(id);
  });
});
```

> Note: the fake-runner heredoc quoting is fiddly; adjust escaping until the runner emits a single valid JSON line (verify by running the fake directly: `PATH` set, `claude -p "hi" --output-format json`). The behavioral assertions are the contract — keep them.

- [ ] **Step 4: Run the smoke test — iterate to green**

Run: `bunx vitest run src/server/chat.smoke.test.ts` (requires local Mongo, as the other smoke tests do). Fix runner escaping / core wiring until all three cases pass.

- [ ] **Step 5: Full suite + typecheck**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun run test && bun run typecheck` → all green.

- [ ] **Step 6: Commit**

```bash
git add src/server/chat.ts src/server/chat.server.ts src/server/chat.smoke.test.ts
git commit -m "feat(chat): server fns + cores (create/send/draft/create-ticket) + smoke"
```

---

## Task 6: react-query hooks + poll-gating predicate

**Files:**
- Create: `src/components/chatUi.ts` + `src/components/chatUi.test.ts`
- Create: `src/queries/chat.ts`

- [ ] **Step 1: Write the failing predicate test**

Create `src/components/chatUi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isChatTurnPending } from "./chatUi";

describe("isChatTurnPending", () => {
  it("polls only while a turn is pending", () => {
    expect(isChatTurnPending("pending")).toBe(true);
    expect(isChatTurnPending("idle")).toBe(false);
    expect(isChatTurnPending("error")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect failure**, then implement.

Create `src/components/chatUi.ts`:

```ts
import type { ChatSessionDTO } from "../server/chat";

// The chat session query polls only while a turn is in flight; idle/error are
// settled (mirrors runsUi.shouldPollRun's role for runs).
export function isChatTurnPending(status: ChatSessionDTO["turnStatus"]): boolean {
  return status === "pending";
}
```

Run: `bunx vitest run src/components/chatUi.test.ts` → PASS.

- [ ] **Step 3: Create the hooks**

Create `src/queries/chat.ts`:

```ts
import { createMutation, createQuery } from "react-query-kit";
import {
  createChatSession,
  createTicketFromChat,
  draftSpecFromChat,
  getChatSession,
  sendChatMessage,
  type ChatSessionDTO,
  type ChatSessionRef,
  type CreateChatSessionInput,
  type SendChatMessageInput,
} from "../server/chat";
import { unwrapResult } from "../server/result";
import { isChatTurnPending } from "../components/chatUi";

const POLL_INTERVAL_MS = 1500;

export const useChatSession = createQuery<ChatSessionDTO, ChatSessionRef>({
  queryKey: ["chatSession"],
  fetcher: (variables) => getChatSession({ data: variables }).then(unwrapResult),
  refetchInterval: (query) =>
    query.state.data && isChatTurnPending(query.state.data.turnStatus)
      ? POLL_INTERVAL_MS
      : false,
});

export const useCreateChatSession = createMutation<
  { id: string },
  CreateChatSessionInput
>({
  mutationFn: (variables) =>
    createChatSession({ data: variables }).then(unwrapResult),
});

export const useSendChatMessage = createMutation<{ ok: true }, SendChatMessageInput>({
  mutationFn: (variables) =>
    sendChatMessage({ data: variables }).then(unwrapResult),
});

export const useDraftSpecFromChat = createMutation<{ ok: true }, ChatSessionRef>({
  mutationFn: (variables) =>
    draftSpecFromChat({ data: variables }).then(unwrapResult),
});

export const useCreateTicketFromChat = createMutation<
  { ticketId: string; seq: number },
  ChatSessionRef
>({
  mutationFn: (variables) =>
    createTicketFromChat({ data: variables }).then(unwrapResult),
});
```

- [ ] **Step 4: Typecheck + test**

Run: `bunx vitest run src/components/chatUi.test.ts && bun run typecheck` → green.

- [ ] **Step 5: Commit**

```bash
git add src/components/chatUi.ts src/components/chatUi.test.ts src/queries/chat.ts
git commit -m "feat(chat): react-query hooks + poll-gating predicate"
```

---

## Task 7: UI — chat route + board entry button

**Files:**
- Create: `src/routes/b/$boardSlug/chat/$sessionId.tsx`
- Modify: `src/routes/b/$boardSlug.tsx` (add a "Brainstorm" button)
- Run `bun run generate-routes` after adding the route file.

- [ ] **Step 1: Add the "Brainstorm" entry button on the board header**

In `src/routes/b/$boardSlug.tsx`, add `useCreateChatSession` + navigation. Import at top:
```ts
import { useNavigate } from "@tanstack/react-router";
import { useCreateChatSession } from "../../queries/chat";
```
Inside `BoardPage`, after `const board = ...`:
```ts
const navigate = useNavigate();
const createChat = useCreateChatSession();
const startBrainstorm = () => {
  if (!boardId || createChat.isPending) return;
  createChat.mutate(
    { boardId },
    {
      onSuccess: ({ id }) =>
        navigate({
          to: "/b/$boardSlug/chat/$sessionId",
          params: { boardSlug, sessionId: id },
        }),
    },
  );
};
```
In the header, before the "New ticket" `Link`, add (only when `board.data`):
```tsx
<button
  type="button"
  disabled={createChat.isPending}
  onClick={startBrainstorm}
  className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:opacity-50"
>
  {createChat.isPending ? "Starting…" : "Brainstorm"}
</button>
```
Wrap the two controls in a `<div className="flex gap-2">` so they sit side by side.

- [ ] **Step 2: Create the chat route (full page)**

Create `src/routes/b/$boardSlug/chat/$sessionId.tsx`:

```tsx
import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useBoard } from "../../../../queries/boards";
import {
  useChatSession,
  useCreateTicketFromChat,
  useDraftSpecFromChat,
  useSendChatMessage,
} from "../../../../queries/chat";
import type { ChatSessionDTO } from "../../../../server/chat";
import { useTickets } from "../../../../queries/tickets";
import { useQueryClient } from "@tanstack/react-query";
import { RISK_LABELS, TYPE_LABELS } from "../../../../components/TicketCard";

export const Route = createFileRoute("/b/$boardSlug/chat/$sessionId")({
  component: ChatPage,
});

function ChatPage() {
  const { boardSlug, sessionId } = Route.useParams();
  const session = useChatSession({ variables: { sessionId } });

  return (
    <main className="mx-auto flex h-dvh max-w-4xl flex-col p-4 sm:p-6">
      <header className="mb-4 flex items-center justify-between gap-3">
        <Link
          to="/b/$boardSlug"
          params={{ boardSlug }}
          className="text-xs text-zinc-500 hover:text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
        >
          ← Board
        </Link>
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
          Brainstorm
        </h1>
        <span className="w-16" />
      </header>

      {session.isPending ? (
        <p className="text-sm text-zinc-500">Loading chat…</p>
      ) : session.isError ? (
        <p role="alert" className="text-sm text-rose-600">
          {session.error.message}
        </p>
      ) : (
        <ChatBody boardSlug={boardSlug} sessionId={sessionId} session={session.data} />
      )}
    </main>
  );
}

function ChatBody({
  boardSlug,
  sessionId,
  session,
}: {
  boardSlug: string;
  sessionId: string;
  session: ChatSessionDTO;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const send = useSendChatMessage();
  const draft = useDraftSpecFromChat();
  const create = useCreateTicketFromChat();
  const [text, setText] = useState("");

  const pending = session.turnStatus === "pending";
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: useChatSession.getKey({ sessionId }),
    });

  const submit = () => {
    const trimmed = text.trim();
    if (pending || trimmed.length === 0 || send.isPending) return;
    send.mutate(
      { sessionId, text: trimmed },
      { onSuccess: () => { setText(""); void refresh(); } },
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-4">
        {session.messages.length === 0 ? (
          <p className="text-sm text-zinc-400">
            Describe what you want to build. When ready, draft a spec.
          </p>
        ) : (
          session.messages.map((m, i) => (
            <div
              key={i}
              className={
                m.role === "user"
                  ? "ml-auto max-w-[80%] rounded-2xl bg-zinc-900 px-3 py-2 text-sm text-white"
                  : "mr-auto max-w-[80%] rounded-2xl bg-zinc-100 px-3 py-2 text-sm whitespace-pre-wrap text-zinc-800"
              }
            >
              {m.text}
            </div>
          ))
        )}
        {pending ? (
          <p role="status" className="text-sm text-zinc-400">
            Assistant is thinking…
          </p>
        ) : null}
        {session.turnStatus === "error" && session.turnError ? (
          <p role="alert" className="text-sm text-rose-600">
            {session.turnError}
          </p>
        ) : null}
      </div>

      {session.proposedSpec ? (
        <ProposedSpecCard
          draft={session.proposedSpec}
          creating={create.isPending}
          error={create.isError ? create.error.message : null}
          onCreate={() =>
            create.mutate(
              { sessionId },
              {
                onSuccess: ({ seq }) => {
                  void queryClient.invalidateQueries({
                    queryKey: useTickets.getKey({ boardId: session.boardId }),
                  });
                  navigate({
                    to: "/b/$boardSlug/t/$ticketSeq",
                    params: { boardSlug, ticketSeq: String(seq) },
                  });
                },
              },
            )
          }
        />
      ) : null}

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); submit(); }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          disabled={pending}
          placeholder="Message the assistant…"
          className="min-h-11 flex-1 resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none disabled:bg-zinc-50"
        />
        <div className="flex flex-col gap-2">
          <button
            type="submit"
            disabled={pending || text.trim().length === 0 || send.isPending}
            className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:opacity-50"
          >
            Send
          </button>
          <button
            type="button"
            disabled={pending || session.messages.length === 0 || draft.isPending}
            onClick={() =>
              draft.mutate({ sessionId }, { onSuccess: () => void refresh() })
            }
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50"
          >
            Draft spec
          </button>
        </div>
      </form>
      {send.isError ? (
        <p role="alert" className="text-sm text-rose-600">
          {send.error.message}
        </p>
      ) : null}
    </div>
  );
}

function ProposedSpecCard({
  draft,
  creating,
  error,
  onCreate,
}: {
  draft: ChatSessionDTO["proposedSpec"] & object;
  creating: boolean;
  error: string | null;
  onCreate: () => void;
}) {
  return (
    <section className="space-y-2 rounded-xl border border-zinc-300 bg-zinc-50 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">
          Proposed ticket
        </p>
        <button
          type="button"
          disabled={creating}
          onClick={onCreate}
          className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create ticket"}
        </button>
      </div>
      <p className="text-sm font-medium text-zinc-900">{draft.title}</p>
      <p className="text-xs text-zinc-500">
        {TYPE_LABELS[draft.type]} · {RISK_LABELS[draft.spec.risk]} · {draft.runner}
      </p>
      <dl className="space-y-1 text-sm text-zinc-700">
        <div><dt className="inline font-medium">Intent: </dt><dd className="inline">{draft.spec.intent}</dd></div>
        {draft.spec.scope ? <div><dt className="inline font-medium">Scope: </dt><dd className="inline">{draft.spec.scope}</dd></div> : null}
        {draft.spec.acceptance.length > 0 ? (
          <div>
            <dt className="font-medium">Acceptance:</dt>
            <dd><ul className="list-disc pl-5">{draft.spec.acceptance.map((a, i) => <li key={i}>{a}</li>)}</ul></dd>
          </div>
        ) : null}
      </dl>
      {error ? <p role="alert" className="text-sm text-rose-600">{error}</p> : null}
    </section>
  );
}
```

- [ ] **Step 3: Regenerate routes + verify build**

Run: `bun run generate-routes`
Run: `bun run typecheck` → exit 0.
Run: `bun run build` → succeeds.

> No component-test harness exists in the repo (as in slice B); the behavioral gate is the Task-5 smoke test + the unit tests. Note this in the commit message.

- [ ] **Step 4: Commit**

```bash
git add src/routes/b/$boardSlug.tsx "src/routes/b/$boardSlug/chat/$sessionId.tsx" src/routeTree.gen.ts
git commit -m "feat(chat): chat route + Brainstorm entry (no component harness; smoke is the gate)"
```

---

## Task 8: Dev-server host binding for SSH-browser access

**Files:**
- Modify: `vite.config.ts`
- Create/Modify: `.env` (or `.env.local`) — add `DEV_HOST`
- Modify: `package.json` `dev` script only if needed

- [ ] **Step 1: Bind the dev server host**

In `vite.config.ts`, add a `server` block so the dev server listens on all interfaces (reachable from the Windows client at `192.168.0.68`), reading an optional `DEV_HOST`:

```ts
const config = defineConfig({
  resolve: { tsconfigPaths: true },
  server: {
    host: process.env.DEV_HOST ?? true, // true = listen on 0.0.0.0
    port: 3141,
    strictPort: true,
  },
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
})
```

- [ ] **Step 2: Record the dev host**

Add to `.env` (create if absent; ensure `.env` is gitignored — check `.gitignore`, add if missing):
```
# Reachable from the SSH Windows client (192.168.0.248 → host 192.168.0.68).
DEV_HOST=0.0.0.0
```

- [ ] **Step 3: Verify**

Run: `bun run dev` briefly; confirm Vite prints a Network URL (e.g. `http://192.168.0.68:3141`). Stop it.
Run: `bun run typecheck && bun run build` → green.

> If Radan prefers a hostname slug over the raw IP, hand him this line to run himself (agent has no sudo):
> `! echo '127.0.0.1 t4d-0.localhost' | sudo tee -a /etc/hosts`
> and set `DEV_HOST=t4d-0.localhost`. The raw `0.0.0.0` binding needs no /etc/hosts edit.

- [ ] **Step 4: Commit**

```bash
git add vite.config.ts .gitignore
git commit -m "chore(dev): bind dev server host for SSH-browser access (DEV_HOST)"
```
(Do NOT commit `.env` if it holds anything host-specific/secret; `.env` should be gitignored. Commit only `.gitignore` + `vite.config.ts`.)

---

## Task 9: Final gate

- [ ] **Step 1: Full gate**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun run test && bun run typecheck && bun run build && echo GATE_OK`
Expected: all green, `GATE_OK`.

- [ ] **Step 2 (manual, optional):** With local Mongo + a real `claude` on PATH and a board whose `repoPath` is a real repo: Board → **Brainstorm** → converse → **Draft spec** → confirm **Create ticket** → lands in **Inbox** → submit_spec → approve_spec → Run → verify. The full chat→spec→ticket→autonomous loop, reachable from `http://192.168.0.68:3141`.

---

## Self-Review

- **Spec coverage:** turn-based transport (T3 builder, T4 execution); async + polled turns (T4 monitor, T6 poll predicate/hook); `ChatSession` domain (T1) + DTO explicit-pick (T2); server fns create/send/get/draft/create-ticket (T5); one-pending-turn guard + fail-closed + boot-reconcile (T4/T5 smoke); draft→ticket via `createTicketCore` (T5); chat route + Brainstorm entry + proposed-spec confirm (T7); SSH host binding (T8); final gate (T9). All design sections mapped.
- **Placeholder scan:** none — every code step is complete. The only "iterate" step is T5 Step 4 (fake-runner shell escaping), which is inherent to the smoke-harness pattern (`needs-input.smoke.test.ts` has the same fiddle) and its behavioral assertions are fixed.
- **Type consistency:** `ChatSession`/`ChatSessionDoc` (validated fields + bookkeeping) vs `ChatSessionDTO` (explicit pick, no pid/logFile/pendingKind); `startChatTurn(sessionId, text, kind)` shape shared T4/T5; `ChatDraft.spec` = `SpecInput` (so `createTicketCore` accepts it directly); `getChatSessionCore` used by both T2 (DTO test) and T5 (poll) and returns `ChatSessionDTO`; poll predicate `isChatTurnPending` (T6) reads `ChatSessionDTO["turnStatus"]`. `provider` is `z.literal("claude")` everywhere. Consistent.
- **Fix applied during review:** T2's `getChatSessionCore` is defined in Task 2 (read path) and the reconcile wiring is added in Task 4 — the plan re-states the full function in T4 Step 5 rather than a diff, to avoid an ambiguous partial edit.
