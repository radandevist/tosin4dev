# Codex Chat Provider — Implementation Plan

> Implement task-by-task, TDD, checkbox steps. Source of truth: `docs/superpowers/specs/2026-07-22-codex-chat-provider-design.md`.

**Goal:** Let a brainstorm chat session run on `codex` (in addition to `claude`), chosen at creation. Provider difference confined to command-build + stdout-parse; everything downstream unchanged.

**Tech:** Bun, TanStack Start, MongoDB standalone + Zod, react-query-kit, Vitest. Chat turn machinery in `src/server/chat.server.ts`; command in `src/server/chatCommand.ts`; parse in `src/server/chatResult.ts`; codex session-id parse already in `src/server/outcome.server.ts` (`parseSessionId`).

**Real codex `--json` schema (captured, authoritative):** `{"type":"thread.started","thread_id":"…"}` then `{"type":"item.completed","item":{"type":"agent_message","text":"…"}}` (assistant text; skip `error`/other item types) then `{"type":"turn.completed",…}`. Command: `codex -C <repoPath> -s read-only exec [resume <threadId>] --json <text>`.

---

## Task 0: Baseline
- [ ] `git branch --show-current` → `feat/v4-codex-chat`. `export PATH="$HOME/.bun/bin:$PATH" && bun run test && bun run typecheck` green. No commit.

## Task 1: Provider enum + create path
**Files:** `src/domain/schemas.ts`, `src/server/chat.server.ts`, `src/server/chat.ts`, `src/queries/chat.ts`; tests `src/domain/chat.schema.test.ts`.

- [ ] **Step 1 (RED):** extend `chat.schema.test.ts` — a session parses with `provider:"codex"`; default is `"claude"`; an invalid provider rejects.
- [ ] **Step 2:** in `schemas.ts` change `ChatSessionSchema.provider` from `z.literal("claude").default("claude")` to `z.enum(["claude","codex"]).default("claude")`.
- [ ] **Step 3:** `createChatSessionCore` — accept `provider` (default `"claude"`) and store it. Update the create server-fn input schema (`src/server/chat.ts`) to accept optional `provider: z.enum(["claude","codex"]).optional()` (`.strict()` preserved); pass it to the core. `useCreateChatSession` hook variables gain optional `provider`. `chatToDTO` already carries `provider` — confirm the DTO schema allows the enum (widen if it's a literal).
- [ ] **Step 4:** typecheck + tests green. **Step 5:** commit `feat(chat): provider enum (claude|codex) + create param`.

## Task 2: Provider-aware `buildChatCommand`
**Files:** `src/server/chatCommand.ts`; test `src/server/chatCommand.test.ts`.

- [ ] **Step 1 (RED):** tests: claude fresh → `["claude","-p",text,"--output-format","json"]`; claude resume → `+["--resume",sid]` (UNCHANGED from current); codex fresh → `["codex","-C",repoPath,"-s","read-only","exec","--json",text]`; codex resume → `["codex","-C",repoPath,"-s","read-only","exec","resume",sid,"--json",text]`.
- [ ] **Step 2:** implement. New signature `buildChatCommand(text, sessionId, provider, repoPath)`:

```ts
export function buildChatCommand(
  text: string,
  sessionId: string | null,
  provider: "claude" | "codex",
  repoPath: string,
): string[] {
  if (provider === "codex") {
    const root = ["codex", "-C", repoPath, "-s", "read-only", "exec"];
    const resume = sessionId ? ["resume", sessionId] : [];
    return [...root, ...resume, "--json", text];
  }
  const cmd = ["claude", "-p", text, "--output-format", "json"];
  if (sessionId) cmd.push("--resume", sessionId);
  return cmd;
}
```

Update the single existing caller in `chat.server.ts` (`startChatTurn`) to pass `session.provider` + `board.repoPath` (the board is already loaded there for cwd — verify and reuse; if not loaded, load it as the claude path already resolves cwd).
- [ ] **Step 3:** typecheck + tests. **Step 4:** commit `feat(chat): provider-aware buildChatCommand (codex exec --json)`.

## Task 3: Provider-aware `parseTurn` + monitor wiring
**Files:** `src/server/chatResult.ts`, `src/server/chat.server.ts`; test `src/server/chatResult.test.ts`.

- [ ] **Step 1 (RED):** tests for `parseTurn(provider, stdout)`: `claude` → same as `parseChatResult` (result + session id); `codex` JSONL with a `thread.started` + an `error` item + an `agent_message` item → `{result:"<agent text>", sessionId:"<thread_id>"}` (proves error items skipped); codex JSONL with NO `agent_message` → null; garbage → null.
- [ ] **Step 2:** implement `parseTurn`:

```ts
export function parseTurn(
  provider: "claude" | "codex",
  stdout: string,
): { result: string; sessionId: string | null } | null {
  if (provider === "claude") return parseChatResult(stdout);
  // codex JSONL: last item.completed with item.type === "agent_message".
  let text: string | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const item = obj?.item as Record<string, unknown> | undefined;
      if (obj?.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
        text = item.text; // keep last
      }
    } catch { continue; }
  }
  if (text === null) return null;
  return { result: text, sessionId: parseSessionId("codex", stdout) };
}
```

(Keep `parseChatResult` as-is; `parseTurn` delegates. Import `parseSessionId` already present.)
- [ ] **Step 3:** in `monitorChatTurn`, replace the `parseChatResult(stdout)` call with `parseTurn(session.provider, stdout)` — the session doc is already loaded in the monitor (or load it; the draft branch already re-loads the session). Everything downstream (message append, bundle `parseBundle` on `result`) is unchanged.
- [ ] **Step 4:** typecheck + full suite green. **Step 5:** commit `feat(chat): provider-aware parseTurn (codex agent_message)`.

## Task 4: Smoke test — fake codex end-to-end
**Files:** Test `src/server/chat-codex.smoke.test.ts` (mirror `chat.smoke.test.ts`'s fake-`claude`-on-PATH bootstrap, but a fake `codex`).

- [ ] **Step 1:** write a fake `codex` executable (shell script on a temp PATH dir) that: echoes the canned JSONL (thread.started with a fixed thread_id, a turn.started, an `item.completed` agent_message whose text is taken from the prompt arg or a fixed reply, turn.completed). Make it handle the `resume <tid>` argument form (still emit an agent_message; may reuse/echo the passed thread id). For the draft/bundle case, the agent_message text must be a valid bundle-proposal JSON.
- [ ] **Step 2 (scenarios, real Mongo):** `createChatSession({boardId, provider:"codex"})` → `sendChatMessage` → monitor → assistant message appended + `thread_id` captured on session; second `sendChatMessage` builds an `exec resume <tid>` command (assert via the fake logging its argv to a file, or assert the second turn still resolves + session id stable); `proposeBundleFromChat` with the fake emitting a bundle JSON as agent_message → drafting bundle stored (proves draft path provider-agnostic); a fake codex run emitting only an `error` item (no agent_message) → `turnStatus:"error"`, session still usable. Do NOT weaken assertions.
- [ ] **Step 3:** run → PASS; typecheck; full suite green. **Step 4:** commit `test(chat): codex provider smoke (fake codex JSONL)`.

## Task 5: UI — provider choice on Brainstorm
**Files:** `src/routes/b/$boardSlug.tsx` (Brainstorm entry), and the chat route `src/routes/b/$boardSlug/chat/$sessionId.tsx` (show provider label).

- [ ] **Step 1:** the Brainstorm affordance gains a provider choice (two small buttons "Claude"/"Codex" or a `<select>`, default Claude) → `createChatSession({boardId, provider})` → navigate to the chat route. Match existing button/zinc styling. The chat route shows a small "via Codex"/"via Claude" label from `session.provider`.
- [ ] **Step 2:** typecheck + build + full suite green. **Step 3:** commit `feat(chat): choose brainstorm provider (claude|codex)`.

## Task 6: Final gate
- [ ] `export PATH="$HOME/.bun/bin:$PATH" && bun run test && bun run typecheck && bun run build && echo GATE_OK`.

## Self-review
- Provider seam is exactly two functions (`buildChatCommand`, `parseTurn`); everything downstream (append, bundle draft, lock) consumes extracted text and is untouched. Codex read-only sandbox (flip-point noted). Fail-closed parse (no `agent_message` → error turn). Real codex schema captured, fake-codex smoke covers it; real-codex E2E is a flagged manual morning step.
