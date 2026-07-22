# Codex Chat Provider — Design

Date: 2026-07-22 (night-shift, self-approved conservative — for morning review)
Parent: fast-path chat slice (`2026-07-22-fast-path-chat-slice-design.md`) shipped a **claude-only** turn-based brainstorm. This adds **codex** as a second brainstorm provider.

## Product

The brainstorm chat is turn-based (`claude -p … --output-format json [--resume]`, async + polled). This slice lets a brainstorm session run on **codex** instead, chosen when the session is created. Everything downstream — message append, the bundle-proposal draft turn, the review panel, lock — is unchanged, because the provider difference is confined to *how a turn's command is built and its stdout parsed*.

## Grounding: real `codex exec --json` schema (captured tonight)

`codex -C <repoPath> -s read-only exec --json '<text>'` emits JSONL:
```
{"type":"thread.started","thread_id":"019f…"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"…hooks warning…"}}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"pong"}}
{"type":"turn.completed","usage":{…}}
```
- **Session id:** `thread.started.thread_id` — already extracted by the existing `parseSessionId("codex", stdout)` (`src/server/outcome.server.ts`). Reuse it.
- **Assistant text:** the `item.completed` event whose `item.type === "agent_message"`, field `item.text`. **Non-`agent_message` items (esp. `type:"error"`) must be skipped.** Take the LAST `agent_message` (defensive).
- Resume: `codex -C <repoPath> -s read-only exec resume <thread_id> --json '<text>'` (form proven by the run adapter `src/runners/codex.ts`).

## Design: provider-aware chat turn

Introduce a tiny per-provider seam; keep everything else provider-agnostic.

### Schema (`src/domain/schemas.ts`)
- `ChatSessionSchema.provider`: `z.literal("claude")` → `z.enum(["claude","codex"]).default("claude")`.
- Provider is chosen at creation and **immutable for the session** (a codex thread can't resume a claude session and vice-versa).

### Command builder (`src/server/chatCommand.ts`)
`buildChatCommand(text, sessionId, provider, repoPath)`:
- `claude` (unchanged): `["claude","-p",text,"--output-format","json", ...(sessionId?["--resume",sessionId]:[])]`.
- `codex`: root flags first — `["codex","-C",repoPath,"-s","read-only","exec", ...(sessionId?["resume",sessionId]:[]), "--json", text]`. (Read-only sandbox: brainstorming never writes the repo. Flip-point: `workspace-write` if a future brainstorm needs to run code — read-only is the safe default.)

### Turn parser (`src/server/chatResult.ts`)
`parseTurn(provider, stdout) → { result: string; sessionId: string | null } | null`:
- `claude`: the existing `parseChatResult` (scan for `{result:string}` + `parseSessionId("claude",…)`).
- `codex`: scan JSONL for the last `item.completed` with `item.type==="agent_message"`; `result = item.text`; `sessionId = parseSessionId("codex", stdout)`. No `agent_message` found → `null` (fail-closed → `turnStatus:"error"`; skips `error`/other items).
- Fail-closed everywhere: unparseable/empty/no-assistant-text → `null`.

### Turn machinery (`src/server/chat.server.ts`)
- `createChatSessionCore({boardId, provider})` stores the chosen provider (default `"claude"`).
- `startChatTurn` builds the command via `buildChatCommand(text, sessionId, session.provider, board.repoPath)`. (It already loads the board for cwd — reuse `board.repoPath`.) For codex, ensure the spawn does **not** leave the process blocked on stdin (pass the prompt as an arg, as runs do; close/ignore stdin — mirror how the supervisor spawns codex runs).
- `monitorChatTurn` parses with `parseTurn(session.provider, stdout)`. Both the `message` branch (append assistant text) and the `draft` branch (bundle proposal) consume the extracted `result` text unchanged — the bundle `parseBundle` runs on `result` exactly as with claude.

### UI (`src/routes/b/$boardSlug.tsx` Brainstorm entry + `createChatSession` call)
- The Brainstorm affordance gains a provider choice (two small buttons or a select: **Claude** | **Codex**, default Claude), passed to `createChatSession({boardId, provider})`. The chat route shows which provider the session runs on (a small label). No other UI change.

## Testing

- **Unit:** `buildChatCommand` — claude fresh/resume unchanged; codex fresh → `codex -C … -s read-only exec --json <text>`; codex resume → `… exec resume <sid> --json <text>`. `parseTurn("codex", …)` — extracts `agent_message.text`, skips `error` items, returns `thread_id`; garbage/no-assistant → null; `parseTurn("claude", …)` unchanged.
- **Smoke (real Mongo, fake `codex` on PATH):** mirror `chat.smoke.test.ts` (which uses a fake `claude`). A fake `codex` shell script emits the canned JSONL above → `createChatSession({provider:"codex"})` → `sendChatMessage` → monitor resolves → assistant message "pong" appended + `thread_id` captured; a second turn builds the `exec resume <tid>` command; a bundle draft turn with a fake codex JSONL whose `agent_message.text` is a bundle JSON → drafting bundle stored (proves the draft path is provider-agnostic). Fake codex emitting only `error` items / no agent_message → `turnStatus:"error"`, session usable.
- **Manual (pending, for morning):** a real `codex` brainstorm turn end-to-end (the captured schema matches real output as of tonight; flagged so you can confirm live).
- Final gate: `bun run test && bun run typecheck && bun run build`.

## Non-goals / deferred

Switching a session's provider mid-conversation. A third provider. Codex-specific brainstorm tuning (temperature/model flags). Streaming (separate slice ④). Provider auto-selection. Codex `workspace-write` brainstorm (read-only only this slice).

## Migration

`ChatSessionSchema.provider` widens `z.literal("claude")` → `z.enum(["claude","codex"]).default("claude")` — existing sessions default to claude (no data migration; the field already exists and every stored session has `"claude"`). Additive command/parse branches + one create param + a UI toggle. No change to runs, the state machine, or the bundle/lock path.
