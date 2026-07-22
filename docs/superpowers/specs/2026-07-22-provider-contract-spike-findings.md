# Provider Contract Spike — Findings (slice A)

Date: 2026-07-22
Status: complete
Method: empirical. Codex side probed by GPT-5.6-Sol against the installed `codex-cli 0.144.6`; Claude side answered by the claude-code-guide agent against current `code.claude.com/docs`.
Feeds: `2026-07-22-tosin4dev-chat-first-pivot-design.md` §3 (decisions A–E), §12.

**Bottom line: the architecture holds. All decisions A–E are confirmed feasible; the spike corrected two minor assumptions and de-risked the chat build (slices C–D). No rework needed.**

## Codex App Server (chat surface for the `codex` provider)

| # | Question | Verdict | Evidence |
|---|----------|---------|----------|
| 1 | Transport + handshake | **CONFIRMED** | `codex app-server` (experimental). `--listen` supports `stdio://` (default, NDJSON), Unix sockets, WebSocket. **Two-stage handshake required**: `initialize` request→response, then an `initialized` notification. Any request before both stages → `-32600 "Not initialized"`. |
| 2 | Thread/turn methods | **CONFIRMED** | Generate types from the pinned CLI: `codex app-server generate-ts`. Requests: `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt`. Notifications: `thread/started`, `turn/started`, `item/started`, `item/agentMessage/delta` (streamed text), `item/completed`, `turn/completed`. |
| 3 | Steer vs start | **CONFIRMED** | `turn/steer` needs `{threadId, input, expectedTurnId}` and only works on the **active** turn; after `turn/completed` it errors `"no active turn to steer"`. **A human unblock after a completed/blocking turn = a fresh `turn/start`.** Race: the `turn/start` response can arrive before the `turn/started` notification — wait for `turn/started` before steering. |
| 4 | App-Server thread → `codex exec resume` continuity | **CONFIRMED (yes)** | An app-server `thread_id` is accepted directly by `codex exec resume <id>` (round-tripped `EXEC_RESUMED`). Sessions persist at `~/.codex/sessions/YYYY/MM/DD/rollout-…-<thread-id>.jsonl` + a `sessions.db` index. So chat-thread → exec-batch continuity is *possible* (we still choose a fresh execution session per §3E, but this is no longer a risk). |
| 5 | `codex exec resume` cwd/sandbox | **CONFIRMED (corrected)** | `codex exec resume` does **not** accept `-C/--cd` or `-s/--sandbox` as *subcommand* flags, **but they work as root-level flags before `exec`**: `codex -C <dir> -s <policy> exec resume --json <id> '…'`. `-c/--config` overrides also work. Resuming without reproducing the original flags still loaded the session. → The spec's "must reproduce config exactly" worry is **relaxed**: pass cwd/sandbox as root flags. |
| 6 | Auth | **CONFIRMED** | Uses the stored ChatGPT login (`~/.codex/auth.json`); `getAuthStatus` → `authMethod: "chatgpt"`; no `OPENAI_API_KEY`/`CODEX_API_KEY` set. Both app-server turns and `exec resume` succeed with it. No separate API key needed. |

## Claude Agent SDK (chat surface for the `claude` provider)

| # | Question | Verdict | Detail |
|---|----------|---------|--------|
| 1 | Long-lived streaming session | **CONFIRMED** | `query(prompt: AsyncGenerator<SDKUserMessage>)` — yield user turns over time into one live session. Build on the **SDK**, not raw CLI stdin. |
| 2 | Token deltas | **CONFIRMED** | `includePartialMessages: true` → `StreamEvent` messages carrying `content_block_delta` / `text_delta` (and `input_json_delta` for tool args). |
| 3 | Session identity + resume | **CONFIRMED** | Local JSONL at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Resume via `resume: <id>` or `continue: true`. Capture `session_id` from the `result` message. A `SessionStore` adapter exists for cross-host. |
| 4 | cwd across turns | **CONFIRMED (risk real)** | Sessions are **cwd-keyed**; resuming from a different cwd **silently starts a NEW session**. Mitigation = **pin `cwd` in query options** per execution session (our §3E). `SessionStore` only needed for cross-host, which we don't need (local, single-user). |
| 5 | Auth | **CONFIRMED (corrected)** | Inherits the user's existing `claude` login (`~/.claude/.credentials.json`); `ANTHROPIC_API_KEY` optional. **Correction:** the SDK does **NOT** bundle its own `claude` binary — it requires `claude` on `PATH` (which this host has). |
| 6 | SDK vs CLI | **CONFIRMED** | Use the SDK (streaming input + `StreamEvent` deltas + programmatic session control). CLI `-p` is one-shot only. |

## Impact on the design spec

- **Decisions A–E all hold.** Two-interface-per-provider (streaming chat surface + `exec`/`-p` batch runner), unblock via a fresh turn (`turn/start` / SDK resume), spec+ledger-seeded execution session, cwd-pinned per worktree — all confirmed feasible on the installed toolchain.
- **Corrections applied to §12:**
  - Codex `exec resume` cwd/sandbox is supplied as **root-level** flags (`codex -C … -s … exec resume …`), not reproduced config — relaxes the topology constraint.
  - The Claude Agent SDK does **not** bundle a `claude` binary (requires it on PATH); auth **inherits the existing login** on both providers — no API key required for this local single-user app.
- **Newly de-risked:** App-Server-thread → `exec` continuity works; the two-stage `initialize`/`initialized` handshake and the exact method/notification names are known; `turn/steer` is confirmed active-turn-only (so Decision D's "unblock = new turn" is the correct and only path).

## What this unblocks

Slice **C** (SpecBundle domain) and **D** (chat adapters + UI) can be designed against concrete protocol facts. The `ConversationAdapter` seam (spec §5) now has known shapes on both sides: `CodexAppServerAdapter` (stdio NDJSON, `initialize`→`initialized`, `thread/*`+`turn/*`, types via `codex app-server generate-ts`) and `ClaudeAgentSdkAdapter` (`query(AsyncGenerator)`, `includePartialMessages`, cwd-pinned resume). **Pin CLI + protocol versions per session** remains mandatory (both are experimental/evolving surfaces).
