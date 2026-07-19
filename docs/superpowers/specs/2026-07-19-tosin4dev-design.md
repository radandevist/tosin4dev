# Tosin4dev — Design Spec

Date: 2026-07-19
Status: draft, awaiting user review
Scope: v1 (option A — minimal loop)

## Product

Tosin4dev ("The OS I need for dev") is a local-first, single-user work-orchestration console.

Radan creates tickets on per-project Kanban boards (publyapp, digital-prevention, ...). After a one-time spec approval, an assigned AI runner (Claude Code CLI or Codex CLI) executes the ticket autonomously to a review-ready state. Radan is pinged only on `blocked` or `review_ready`, then does final review/approval. Merge of any PR always stays manual.

The app owns tickets, runs, and workflow state. Runners are interchangeable execution backends. GitHub remains the canonical PR surface (linked, not synced).

## Non-goals (v1)

- No Hermes adapter (adapter seam exists, implementation deferred)
- No GitHub issue sync (links only)
- No auth/multi-user, no cloud, no mobile
- No in-app code editor or diff viewer (link out to PR / open logs)
- No artifacts browser beyond logs + links
- No two-way GitHub status sync, no webhooks from GitHub

## Stack

- **App**: TanStack Start — server functions are the whole API; no separate backend process.
- **Data layer**: TanStack Query via `react-query-kit` (same pattern as PublyApp).
- **DB**: MongoDB wire protocol via official `mongodb` driver + Zod at boundaries. No ORM.
- **DB runtime**: official MongoDB image in docker-compose, bound to 127.0.0.1 (host has AVX2; no compatibility constraint). Local-first — no Atlas dependency for this tool.
- **Runtime**: Bun (package manager + dev server + runner supervision). Fallback: Node for the supervisor module only if Bun process handling misbehaves in practice.
- **UI**: visual language adapted from `~/Projects/PublyApp/.references/gray-ui-csm` (Next.js template — port components/tokens, not the framework). Tailwind 4 + Base UI/shadcn-style primitives.
- **Package layout**: single package, not a monorepo. `apps/` split is ceremony for one local app.

## Repo

- Path: `/home/radan/Projects/Tosin4dev/tosin4dev` (container dir `Tosin4dev/` is not a repo, matching Projects convention)
- Public: https://github.com/radandevist/tosin4dev, branch `main`
- Secrets in `.env` (untracked): Discord webhook URL, DB connection, any CLI env the runners need.

## Domain model

Four collections. Embedded subdocs instead of extra collections wherever a thing has no independent life (activity entries, gates).

### Board

```ts
{
  _id: ObjectId,
  slug: string,            // "publyapp" — unique
  name: string,
  repoPath: string,        // absolute path the runner works in
  defaultBaseBranch: string, // e.g. "develop"
  createdAt: Date
}
```

### Ticket

```ts
{
  _id: ObjectId,
  boardId: ObjectId,
  seq: number,             // per-board human id: "PUB-12"
  title: string,
  type: "research" | "spec" | "implement" | "bugfix" | "review",
  status: TicketStatus,    // state machine below
  runner: "claude" | "codex",
  spec: {
    intent: string,
    scope: string,         // allowed paths/modules
    nonGoals: string,
    acceptance: string[],  // observable criteria
    links: string[],       // issue/PR/design URLs
    risk: "low" | "medium" | "high",
    approvedAt: Date | null,
    approvedBy: "radan" | null
  },
  activeRunId: ObjectId | null,
  prUrl: string | null,
  activity: [{ at: Date, kind: string, message: string }],  // capped tail
  createdAt: Date, updatedAt: Date
}
```

### Run

```ts
{
  _id: ObjectId,
  ticketId: ObjectId,
  boardId: ObjectId,
  runner: "claude" | "codex",
  phase: "spec_draft" | "execute" | "review_fix",
  status: "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled",
  pid: number | null,
  workDir: string,         // .tosin4dev/runs/<runId>/ inside board repo
  promptFile: string,      // generated brief given to the runner
  logFile: string,
  exitCode: number | null,
  startedAt: Date | null, finishedAt: Date | null,
  summary: string | null   // runner's final handoff text
}
```

### Artifact — skipped in v1.

Run outputs live as files under the run dir; the Run doc carries paths. A separate artifacts collection is scaffolding for later. `// ponytail: add when we need to query artifacts independently of runs.`

## State machine

```
inbox ──draft spec──▶ spec_review ──approve──▶ approved ──dispatch──▶ running
  ▲                      │                        ▲                    │
  │                   request changes             │                failure/block
  │                      │                        │                    ▼
  └──────────────────────┴────────────────────────┴──────────────── blocked ──resume──▶ approved
                                                                 running
                                                                   │ success
                                                                   ▼
                                                             review_ready ──final approve──▶ done
                                                                   │
                                                             request changes ──▶ running (review_fix run)
```

- `archived` is a terminal side-state reachable from anywhere.
- Only two statuses ever wait on Radan: `spec_review` and `review_ready` (plus `blocked`, which is exceptional).
- `approved` tickets are picked for dispatch manually in v1 ("Run" button) — automatic queue draining is a v1.1 decision. `// ponytail: auto-dispatch approved tickets once the manual loop is trusted.`

## Runner adapters

One interface, two implementations in v1, seam for Hermes later:

```ts
interface RunnerAdapter {
  name: "claude" | "codex";
  buildCommand(brief: RunnerBrief): { cmd: string[]; env: Record<string, string> };
  // start/stop/status are shared supervisor code; the adapter only knows how to invoke.
}
```

- **claude**: `claude -p "<prompt file contents>" --output-format text` (non-interactive, headless). Dangerous-permission flags per ticket risk policy, default: none — the runner works inside a git worktree/branch so damage is contained.
- **codex**: `codex exec --cd <workdir> "<prompt>"` (headless, sandboxed by default).
- Adapters are pure command builders. No adapter may contain workflow logic.

### Isolation

Each execute run gets a git worktree `<repo>/.tosin4dev/worktrees/<runId>` branched from the board's `defaultBaseBranch`, so concurrent runs never share a checkout and the main checkout is never dirty. `spec_draft` runs are read-only against the main checkout (no worktree needed).

### Supervision

TanStack Start's server process is long-lived, so supervision is in-process:

1. `dispatchRun` server function creates the Run doc, worktree, prompt file; spawns the CLI via `Bun.spawn`, pipes stdout/stderr to the log file.
2. On exit: update Run (`exitCode`, `status`, `finishedAt`), parse the runner's tail summary, transition the ticket (`review_ready` or `blocked`), send notification if needed.
3. Boot recovery: any Run left `running` whose pid is dead → `failed`, ticket → `blocked` with a resume path.
4. One run per ticket at a time (unique partial index on `activeRunId != null`); global concurrency cap (default 4) via a config doc — host: i5-12500T, 12 threads, 61GB RAM. Heavy verification (docker builds, e2e) is throttled to 1 via a separate heavy-job slot.

### Notifications

Discord webhook to `#notifications` (URL in `.env`), posted on exactly two transitions: `blocked` and `review_ready`. Message = ticket id, title, board, state, log path, one-line summary. No other pings.

## UI

Routes:

- `/` — board list
- `/b/$boardSlug` — Kanban board (columns = statuses), drag between non-gated columns; gated transitions are buttons, not drags
- `/b/$boardSlug/t/$ticketSeq` — ticket detail: spec editor, activity feed, runs list with live-tailing log (react-query `refetchInterval`), gate buttons (Approve spec / Request changes / Approve final / Reopen), PR link
- `/b/$boardSlug/new` — create ticket (template enforces intent/scope/non-goals/acceptance/risk)

Components/tokens adapted from gray-ui-csm: card, table, drawer, badge, button, input, select, tabs, confirm-dialog. Port by hand as needed — do not bulk-copy the template.

## Server functions (react-query-kit routers)

- `boards`: list, create, get
- `tickets`: listByBoard, get, create, updateSpec, transition (validates state machine), setRunner
- `runs`: listByTicket, get, dispatch, cancel, logTail

All mutations validate with Zod; state transitions go through one `transitionTicket` function so the state machine has exactly one implementation.

## Error handling

- Runner spawn failure → Run `failed`, ticket unchanged + activity entry, visible immediately.
- Runner nonzero exit → ticket `blocked` with exit code + log tail.
- Worktree creation conflict → run refuses to start, ticket stays `approved`.
- DB unavailable → UI error boundary with retry; no silent degradation.
- All server functions return typed `{ ok: true, data } | { ok: false, error }` — no thrown strings across the wire.

## Testing (minimal)

- Vitest unit tests for: state machine transitions (the one place bugs compound), prompt/brief builder, Zod schemas.
- One integration smoke: dispatch a fake runner (`/bin/echo`) through the full supervisor path in a temp git repo → proves spawn, log capture, exit handling, ticket transition.
- No e2e browser suite in v1. `// ponytail: add Playwright when the UI stops changing weekly.`

## Operational files

- `docker-compose.yml`: mongo, host port bound to 127.0.0.1
- `.env.example`: `MONGODB_URI`, `DISCORD_WEBHOOK_URL`
- `justfile`: `dev`, `db-up`, `db-down`, `test`, `typecheck`

## Delivery order (for the implementation plan)

1. Scaffold: TanStack Start + Bun + Tailwind + compose + DB client + Zod
2. Domain: collections, schemas, state machine + tests
3. Server functions + react-query-kit routers
4. Board/ticket UI (list, create, detail, board view)
5. Runner adapters + supervisor + worktree isolation + smoke test
6. Gates UI + notifications
7. Polish pass against gray-ui-csm look, README
