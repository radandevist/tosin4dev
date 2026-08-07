# First real run: a PublyApp ticket to a draft PR

Date: 2026-08-07
Status: design approved by owner, not yet planned or implemented

## Why now

The app was booted against a real board on 2026-08-07 and the database was read. It had
already been used on 2026-08-06 — a `publyapp` board pointing at
`/home/radan/Projects/PublyApp/publyapp` with `defaultBaseBranch: develop`, one ticket
(*confetti effect on landing page*), one run, five chat sessions.

What that evidence shows, in order of severity:

1. **The board's `checks` array is empty**, and `verdictFrom` treats that as a pass:

   ```ts
   // No checks configured => a commit alone passes
   // (still strictly better than v1's "exit 0 = done").
   ```

   On the only board that exists, the verification contract degrades to *the agent made a
   commit*. The differentiator is opt-in and it is off.

2. **A `spec_draft` run succeeded and its output went nowhere.** The run produced a
   ten-point spec with real file paths, a named risk and two flagged ambiguities. The ticket
   is still `inbox` with `acceptance: []` and `scope: ''`. There is no path from a drafted
   spec to the ticket that requested it.

3. **Five brainstorm chat sessions, all `active`, none concluded**, created within fifty
   minutes of each other. The chat-to-ticket flow was attempted repeatedly and abandoned
   every time.

4. Nothing pushes a branch or opens a pull request.

5. A failed check ends the run. There is no path back to the agent.

Findings 1, 2, 4 and 5 are this spec. Finding 3 is the ticket-drawer redesign
(`2026-08-06-ticket-drawer-tabs-design.md`) and is deliberately out of scope — it is six
pieces of work and none of them ends in a pull request.

## Goal

One PublyApp ticket goes from an owner-approved spec to a draft PR without the owner
touching a terminal, and the checks it passed mean something.

The owner gate stays where it is: approve the spec before dispatch, then unattended until a
draft PR exists or the run is genuinely blocked. Merge remains an explicit owner action.

## Scope, in build order

Each step is independently useful and independently verifiable.

### 1. An empty `checks` array refuses to dispatch

A board with no configured checks cannot dispatch a run. The server refuses; the board UI
says why and links to the checks editor.

This reverses a deliberate documented decision, and the reversal is the point. A tool whose
entire premise is *verify that the work happened* must not silently accept "a commit
appeared" as verification. The old behaviour was defensible when nothing else existed; it is
not defensible as a default.

`verdictFrom` itself is **unchanged**. Its no-checks branch stays reachable and tested,
because a board's checks can be emptied between dispatch and verification, and a run already
in flight must still reach a verdict rather than throw.

### 2. PublyApp's checks

Configuration, not code: `pnpm lint` and `pnpm format`, as argv arrays, against
`/home/radan/Projects/PublyApp/publyapp`.

Recorded here so the first run is reproducible, not because it needs implementing.

### 3. Apply a drafted spec to its ticket

A `spec_draft` run that succeeds writes its result into the ticket that requested it,
automatically, moving `inbox → spec_review` via the existing `submit_spec` edge. The owner
then approves or edits.

**Automatic, and only from `inbox`.** `inbox` is the only status carrying a `submit_spec`
edge, so the guard is the state machine's own: a draft that completes against a ticket which
has moved on is refused rather than clobbering a spec the owner has since worked on.

The draft is applied as a whole, and the ticket's existing spec is overwritten. Field-level
merging is a spec *editor* — that belongs to the drawer redesign, not here.

If the drafted spec fails `SpecSchema` validation, the write is refused and the failure is
surfaced with the offending field. A partially-applied spec is worse than none: it looks
approved-ready while missing the acceptance criteria the whole contract rests on.

### 4. The fix loop

When verification returns `failed` with `verification_failed`, the failing output goes back
to the agent as a new turn on the existing leased execution session, and the run re-verifies.

Reuses the turn machinery `resumeRun` already has. The ticket stays `running` throughout —
no new status, no new edge, `stateMachine.ts` untouched.

**`no_commit` does not retry.** An agent that committed nothing has a different problem, and
re-prompting it burns twenty minutes to reach the same place.

Four guards, each adapted from a documented incident in
`Untrivial-ai/agent-orchestrator` (studied 2026-08-07, `/home/radan/Projects/_reference/agent-orchestrator`):

**Attempt budget.** `fixAttempts` on the run, default 2. Exhausted → falls through to
today's failure path unchanged. AO retries CI failures unboundedly; unbounded is wrong here
because every attempt costs tokens the owner pays for.

**Head-SHA guard.** Record the branch tip when verification starts; re-read it before
delivering feedback. If it moved, the agent committed again while checks ran and those
failures describe a commit that no longer exists — discard the feedback and re-verify.

**Dedup signature.** Hash the failing check keys, their exit codes, and the last 2 KB of
each failing check's output — bounded so a run-to-run varying prefix (timings, paths) cannot
make two identical failures look different.
A signature identical to the one already delivered **stops the loop**: the agent has
seen this exact failure and did not fix it. This is what separates a bounded retry from a
token bonfire.

**Sent vs suppressed.** If the run is parked in `needs_input` or its lease has expired,
feedback is not marked delivered and re-fires on resume. Fail closed — a suppressed message
counted as sent leaves an agent waiting on advice it never received.

Every attempt writes its own `evidence` row, so the sequence is inspectable afterwards, not
just the final state.

`notifyBlocked` gains the attempt count and the reason the loop stopped. Budget exhausted and
repeated signature are different diagnoses and must not read the same.

### 5. Push and draft PR

On `verdict: passed`: push the branch, open a **draft** PR against
`board.defaultBaseBranch`, store the URL on the run, transition the ticket to `review_ready`,
notify.

Nothing ever marks a PR ready for review. Merge is the owner's.

**Guards on the one irreversible step:**

- **Preflight at dispatch, not at push.** `gh auth status` and remote reachability are
  checked before the agent starts. Discovering a broken token after twenty minutes of agent
  work is the worst available ordering.
- **Never push the base.** Assert `branch !== board.defaultBaseBranch` and refuse. The
  namespaced `tosin4dev/run/<runId>` branch makes this near-impossible; assert anyway,
  because "never touch `develop` directly" is a standing rule and an assertion is how it
  stays true.
- **`git push -u origin <branch>`. Never `--force`, never `--force-with-lease`.** A rejected
  push is information.
- **Idempotent PR creation.** `gh pr list --head <branch>` first; reuse an existing PR's URL.
  Without this the fix loop's second attempt opens a second PR.

**The failure path matters more than the happy one.** If push or PR creation fails, the
agent's verified commit exists only on a local branch — and the existing cleanup path calls
`git branch -D`. Running it here would destroy verified work because a network call failed.

So on push failure: the ticket goes to `blocked`; the notification carries the branch name
and the exact command to push it by hand; **the worktree and the branch are left intact.**

**PR body** is assembled from what already exists — the ticket spec, the run summary, and the
`evidence` rows (checks run, exit codes, commit sha). The verification contract becomes
visible to anyone reading the PR instead of living only in MongoDB.

## Data flow

```
approve spec  →  dispatch (preflight: checks non-empty, gh authed, remote reachable)
              →  createRunBranch  →  agent works  →  commits
              →  verifyRun
                   ├─ passed        →  push  →  draft PR  →  review_ready  →  notify
                   ├─ no_commit     →  blocked (no retry)
                   └─ verification_failed
                        ├─ budget left, SHA stable, new signature  →  feed back, re-verify
                        └─ otherwise                                →  blocked + why
```

## Error handling

- **Checks empty at dispatch** → refuse before any agent starts. Nothing is spawned, nothing
  to clean up.
- **`gh` unauthenticated at dispatch** → refuse, same reasoning.
- **Drafted spec fails validation** → refuse the write, name the field, leave the ticket in
  `inbox`.
- **Branch tip moved during verification** → discard feedback, re-verify. Do not deliver
  failures about a commit that no longer exists.
- **Feedback suppressed (parked / lease expired)** → not marked delivered, re-fires on
  resume.
- **Push or PR creation fails** → `blocked`, worktree and branch preserved, manual command in
  the notification.
- **PR already exists for the branch** → reuse it. Never create a second.

## Testing

Every test answers: **which revert makes this fail, and does it fail on its own `expect`?**
This codebase has shipped tests that passed while pinning nothing.

- Dispatch is refused when `board.checks` is empty — and specifically that no worktree is
  created and no process is spawned.
- `verdictFrom`'s no-checks branch still returns `passed` on a commit (it stays reachable for
  in-flight runs).
- Applying a drafted spec moves `inbox → spec_review` and the written spec is what a
  subsequent read returns.
- Applying an invalid drafted spec refuses and leaves the ticket in `inbox`.
- Fix loop, one test per guard, each proven by reverting that guard alone:
  - budget exhausted → falls through to the existing failure path
  - branch tip moved → feedback is not delivered
  - repeated signature → loop stops, and stops *before* consuming the remaining budget
  - parked run → feedback not marked delivered, and re-fires on resume
- `no_commit` does not retry.
- Push path against a local bare repo as `origin`: success opens exactly one draft PR;
  a second verification pass reuses it rather than opening a second.
- **Push failure leaves the branch and worktree intact** — assert the branch still exists
  after the failure. This is the test that protects real work.

## Out of scope

- The ticket-drawer redesign, including chat-to-spec and the Spec tab
  (`2026-08-06-ticket-drawer-tabs-design.md`).
- Moving runs out of the Vite dev server. Not needed while the target repo is PublyApp — the
  dev server only restarts when Tosin4dev's own source changes. Required before the app can
  build itself.
- Authentication (issue #23).
- Any change to `stateMachine.ts`.
- Marking a PR ready for review, or merging it.
