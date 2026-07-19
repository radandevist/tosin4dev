# Tosin4dev

Tosin4dev is a local-first orchestration console for running human-approved development tickets through Claude Code or Codex. It provides boards and tickets, explicit spec and final-review gates, manual runner dispatch, isolated Git worktrees, run logs, and optional Discord notifications for blocked and review-ready tickets.

## Prerequisites

- [Bun](https://bun.sh/)
- Docker with Docker Compose
- [`just`](https://github.com/casey/just)
- Git
- An authenticated `claude` and/or `codex` CLI available on `PATH`

## Quickstart

```bash
bun install
cp .env.example .env
just db-up
just dev
```

Open <http://127.0.0.1:3141>.

Create a board with the absolute `repoPath` of the Git repository Tosin4dev should operate on. Set its default base branch to the branch new execution worktrees should start from, such as `main` or `develop`.

## Ticket lifecycle

The workflow is deliberately manual:

1. Create a ticket and fill in its spec fields.
2. Optionally select **Draft spec with Claude** or **Draft spec with Codex** for a read-only runner pass.
3. Select **Submit for spec review**.
4. Select **Approve spec**, or **Request changes** to return it to the inbox.
5. Select **Run now**. Tosin4dev creates an isolated Git worktree and dispatches the selected runner.
6. Follow the run output in the ticket logs. A successful execution moves the ticket to **Review Ready**; a failed execution moves it to **Blocked**.
7. At **Review Ready**, select **Final approve** to finish or **Request changes** to continue the work.

Runner execution is local. The selected CLI works inside the isolated worktree and commits there, but Tosin4dev does not push branches or open pull requests.

## Configuration

`.env.example` configures the local MongoDB connection. Set `DISCORD_WEBHOOK_URL` in `.env` to receive optional blocked and review-ready notifications; leave it blank to disable notifications.

## Useful commands

```bash
bun run test
bun run typecheck
bun run build
just db-down
```
