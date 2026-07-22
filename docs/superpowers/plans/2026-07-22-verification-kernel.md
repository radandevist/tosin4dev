# Verification Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove a ticket's execute-run actually produced committed, acceptance-passing work before it can reach `review_ready` — closing v1's `exitCode === 0` false-success gap on existing form-authored tickets.

**Architecture:** Harden the existing execute-phase run path in `src/server/supervisor.server.ts`. Replace the detached worktree with a named per-run branch, capture its base SHA, and after the runner exits 0 run a **verification stage owned by Tosin4dev** — a reachable new commit on the run branch plus each board-configured acceptance command (argv via `execFile`, no shell) run in the worktree. Persist an `Evidence` document, and only transition to `review_ready` when the verdict is `passed`; a failed verdict routes to `blocked` with a distinct reason. Wire the existing `recoverOrphans` into a boot-once guard.

**Scope (Sol's minimal first slice):** This plan does NOT introduce the full `Run→Turn` / `EventJournal` / lease rework from the design spec (§4 step 2 full form) — that is deferred to a follow-up sub-plan. It extends the existing `Run` document in place. Chat/SpecBundle/adapters (steps 4–5) are out of scope.

**Tech Stack:** Bun, TanStack Start, mongodb driver + Zod, Vitest, `node:child_process` (`execFile`/`spawn`), git worktrees.

Spec: `docs/superpowers/specs/2026-07-22-tosin4dev-chat-first-pivot-design.md` (§3 decision "Verification", §5, §6 `Evidence`/`Run`, §8).

**Conventions for all tasks:**
- All commands run from repo root `/home/radan/Projects/Tosin4dev/tosin4dev`.
- Tests: `bun run test` (vitest run). Typecheck: `bun run typecheck`. Run a single file: `bunx vitest run src/path/file.test.ts`.
- `export PATH="$HOME/.bun/bin:$PATH"` if `bun` is not found. Run `bun install` once before Task 1 (this checkout has no `node_modules`).
- Commit after every task with the message shown in its final step.
- Follow existing patterns: `ServerResultError` for expected failures, `now()` = `new Date().toISOString()`, `execFileAsync` for git, Zod schemas in `src/domain/schemas.ts`.

---

## Task 0: Install dependencies (one-time)

**Files:** none

- [ ] **Step 1: Install and confirm the suite is green before changes**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun install
bun run test
bun run typecheck
```
Expected: install completes; `vitest` runs (existing tests pass or the suite reports its current baseline); `tsc --noEmit` exits 0. Note any pre-existing failures before proceeding.

---

## Task 1: Board acceptance-check config

Add an ordered list of acceptance commands to a board. Each references a stable `key`, carries a human `label`, an argv `command` (no shell), and a `timeoutMs`. Existing boards default to an empty list (no checks configured).

**Files:**
- Modify: `src/domain/schemas.ts` (add `BoardCheck`, extend `BoardSchema`)
- Test: `src/domain/schemas.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/domain/schemas.test.ts`:

```ts
import { BoardSchema } from "./schemas";

describe("BoardSchema.checks", () => {
  const base = {
    slug: "publyapp",
    name: "PublyApp",
    repoPath: "/home/radan/Projects/PublyApp/publyapp",
    defaultBaseBranch: "develop",
  };

  it("defaults checks to an empty array", () => {
    const board = BoardSchema.parse(base);
    expect(board.checks).toEqual([]);
  });

  it("accepts argv checks with a timeout", () => {
    const board = BoardSchema.parse({
      ...base,
      checks: [
        { key: "typecheck", label: "Typecheck", command: ["bun", "run", "typecheck"], timeoutMs: 120000 },
      ],
    });
    expect(board.checks[0].command).toEqual(["bun", "run", "typecheck"]);
  });

  it("rejects a check with an empty command", () => {
    expect(() =>
      BoardSchema.parse({ ...base, checks: [{ key: "x", label: "X", command: [], timeoutMs: 1000 }] }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/domain/schemas.test.ts -t "BoardSchema.checks"`
Expected: FAIL — `board.checks` is `undefined` (property not defined on schema).

- [ ] **Step 3: Add the schema**

In `src/domain/schemas.ts`, add above `BoardSchema`:

```ts
// One acceptance command Tosin4dev runs itself to verify a ticket's work.
// `command` is an argv array executed with no shell (execFile semantics), so a
// board's stored check can never be a shell-injection vector. `key` is stable
// and referenced by Evidence; `timeoutMs` bounds a hung check.
export const BoardCheck = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  command: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive().default(120_000),
});
export type BoardCheck = z.infer<typeof BoardCheck>;
```

Then extend `BoardSchema` (add the `checks` field after `defaultBaseBranch`):

```ts
export const BoardSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  repoPath: AbsolutePathString,
  defaultBaseBranch: z.string().min(1),
  checks: z.array(BoardCheck).default([]),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/domain/schemas.test.ts -t "BoardSchema.checks"`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add src/domain/schemas.ts src/domain/schemas.test.ts
git commit -m "feat: board acceptance-check config"
```

---

## Task 2: Evidence schema

The persisted proof a run produced verifiable work: the named commit, per-check results, and a verdict.

**Files:**
- Modify: `src/domain/schemas.ts`
- Test: `src/domain/schemas.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/domain/schemas.test.ts`:

```ts
import { EvidenceSchema } from "./schemas";

describe("EvidenceSchema", () => {
  it("parses a passed verdict with check results", () => {
    const ev = EvidenceSchema.parse({
      runId: "a".repeat(24),
      ticketId: "b".repeat(24),
      commitSha: "0".repeat(40),
      commitRef: "tosin4dev/run/abc",
      checks: [
        { key: "typecheck", command: ["bun", "run", "typecheck"], exitCode: 0, outputRef: "/x/checks/typecheck.log", passedAt: "2026-07-22T00:00:00.000Z" },
      ],
      verdict: "passed",
    });
    expect(ev.verdict).toBe("passed");
  });

  it("rejects an unknown verdict", () => {
    expect(() =>
      EvidenceSchema.parse({
        runId: "a".repeat(24), ticketId: "b".repeat(24), commitSha: "0".repeat(40),
        commitRef: "r", checks: [], verdict: "maybe",
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/domain/schemas.test.ts -t "EvidenceSchema"`
Expected: FAIL — `EvidenceSchema` is not exported.

- [ ] **Step 3: Add the schema**

In `src/domain/schemas.ts`, after `RunSchema`:

```ts
export const EvidenceCheck = z.object({
  key: z.string().min(1),
  command: z.array(z.string()),
  exitCode: z.number().int(),
  outputRef: z.string(),          // path to the captured check log
  passedAt: z.string().datetime(),
});
export const EvidenceVerdict = z.enum(["passed", "failed"]);
export const EvidenceSchema = z.object({
  runId: ObjectIdString,
  ticketId: ObjectIdString,
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  commitRef: z.string().min(1),
  checks: z.array(EvidenceCheck).default([]),
  verdict: EvidenceVerdict,
});
export type Evidence = z.infer<typeof EvidenceSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/domain/schemas.test.ts -t "EvidenceSchema"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run typecheck
git add src/domain/schemas.ts src/domain/schemas.test.ts
git commit -m "feat: evidence schema"
```

---

## Task 3: Extend Run with branch, baseSha, verdict, failureKind; add `verifying` status

The run document must carry the named branch + base SHA (to detect a reachable new commit) and record the verification verdict and a distinct failure reason.

**Files:**
- Modify: `src/domain/schemas.ts` (`RunStatus`, `RunSchema`)
- Test: `src/domain/schemas.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/domain/schemas.test.ts`:

```ts
import { RunSchema, RunStatus } from "./schemas";

describe("RunSchema verification fields", () => {
  const base = {
    ticketId: "a".repeat(24), boardId: "b".repeat(24), runner: "claude",
    phase: "execute", status: "queued",
    workDir: "/repo/.tosin4dev/worktrees/x", promptFile: "/repo/.tosin4dev/runs/x/prompt.md",
    logFile: "/repo/.tosin4dev/runs/x/output.log",
  };

  it("defaults new verification fields to null", () => {
    const run = RunSchema.parse(base);
    expect(run.branch).toBeNull();
    expect(run.baseSha).toBeNull();
    expect(run.verdict).toBeNull();
    expect(run.failureKind).toBeNull();
  });

  it("accepts a verifying status and a verification failureKind", () => {
    expect(RunStatus.parse("verifying")).toBe("verifying");
    const run = RunSchema.parse({ ...base, status: "failed", failureKind: "verification_failed" });
    expect(run.failureKind).toBe("verification_failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/domain/schemas.test.ts -t "RunSchema verification fields"`
Expected: FAIL — `verifying` not in enum / `branch` undefined.

- [ ] **Step 3: Extend the schema**

In `src/domain/schemas.ts`, replace `RunStatus` and add fields to `RunSchema`:

```ts
export const RunStatus = z.enum([
  "queued",
  "running",
  "verifying",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
]);
```

Add these fields inside `RunSchema` (after `summary`):

```ts
  // Execution worktree branch + its base commit. spec_draft runs work in the
  // repo root with no branch, so both are null there.
  branch: z.string().nullable().default(null),
  baseSha: z.string().nullable().default(null),
  // Verification outcome, set during the `verifying` stage. null until verified.
  verdict: z.enum(["passed", "failed"]).nullable().default(null),
  // Distinguishes WHY a run failed: a nonzero runner exit vs. a runner that
  // exited 0 but produced no reachable commit / failed an acceptance check.
  failureKind: z
    .enum(["runner_exit", "no_commit", "verification_failed"])
    .nullable()
    .default(null),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/domain/schemas.test.ts -t "RunSchema verification fields"`
Expected: PASS.

- [ ] **Step 5: Fix existing run-doc literals broken by the new required fields**

Zod `.default(null)` makes `branch`/`baseSha`/`verdict`/`failureKind` part of the `Run` **output** type, so raw `runs.insertOne({...})` literals no longer typecheck. Update the two literal inserts in the orphan-recovery test in `src/server/supervisor.smoke.test.ts` (around lines 236 and 264) to include:

```ts
      branch: null,
      baseSha: null,
      verdict: null,
      failureKind: null,
```

(Add these four keys alongside the existing `pid`/`exitCode`/`summary`/`queuedAt`/… keys in each `runs.insertOne(...)` object.)

- [ ] **Step 6: Typecheck (catches any other stale literal) + commit**

```bash
bun run typecheck
git add src/domain/schemas.ts src/domain/schemas.test.ts src/server/supervisor.smoke.test.ts
git commit -m "feat: run verification fields + verifying status"
```

---

## Task 4: Named per-run branch (replace detached worktree)

Verification needs a reachable named ref. Change `runGitWorktree` to create the worktree on a fresh branch `tosin4dev/run/<runId>` off the board's base branch, and capture the base SHA. On cleanup of an unused worktree, also delete that branch.

**Files:**
- Modify: `src/server/supervisor.server.ts` (`runGitWorktree`, `removeUnusedWorktree`, `runPaths`, `dispatchRun` run doc, `RunDoc` type)
- Test: `src/server/worktree.smoke.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `src/server/worktree.smoke.test.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunBranch, runBranchName } from "./supervisor.server";

const exec = promisify(execFile);

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "t4d-wt-"));
  await exec("git", ["-C", dir, "init", "-b", "main"]);
  await exec("git", ["-C", dir, "config", "user.email", "t@t"]);
  await exec("git", ["-C", dir, "config", "user.name", "t"]);
  await exec("git", ["-C", dir, "commit", "--allow-empty", "-m", "root"]);
  return dir;
}

describe("createRunBranch", () => {
  let repo: string;
  beforeEach(async () => { repo = await initRepo(); });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  it("creates a named worktree branch and returns the base sha", async () => {
    const workDir = join(repo, ".tosin4dev/worktrees/run1");
    const { branch, baseSha } = await createRunBranch(repo, workDir, "main", "run1");
    expect(branch).toBe(runBranchName("run1"));
    expect(baseSha).toMatch(/^[0-9a-f]{40}$/);
    const { stdout } = await exec("git", ["-C", repo, "branch", "--list", branch]);
    expect(stdout).toContain(branch);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/server/worktree.smoke.test.ts`
Expected: FAIL — `createRunBranch` / `runBranchName` are not exported.

- [ ] **Step 3: Implement named-branch creation**

In `src/server/supervisor.server.ts`, add exported helpers and replace `runGitWorktree`:

```ts
export function runBranchName(runId: string): string {
  return `tosin4dev/run/${runId}`;
}

// Create the execution worktree on a fresh named branch off `baseBranch`, and
// return the branch name plus the base commit sha the branch started from. The
// named branch (unlike v1's --detach) gives verification a reachable ref.
export async function createRunBranch(
  repoPath: string,
  workDir: string,
  baseBranch: string,
  runId: string,
): Promise<{ branch: string; baseSha: string }> {
  const branch = runBranchName(runId);
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repoPath, "rev-parse", baseBranch],
    { encoding: "utf8" },
  );
  const baseSha = stdout.trim();
  await execFileAsync(
    "git",
    ["-C", repoPath, "worktree", "add", "-b", branch, workDir, baseBranch],
    { encoding: "utf8" },
  );
  return { branch, baseSha };
}
```

Delete the old `runGitWorktree`. Update `removeUnusedWorktree` to also delete the branch:

```ts
async function removeUnusedWorktree(
  repoPath: string,
  workDir: string,
  branch: string | null,
): Promise<void> {
  await execFileAsync(
    "git",
    ["-C", repoPath, "worktree", "remove", "--force", workDir],
    { encoding: "utf8" },
  ).catch(() => undefined);
  if (branch) {
    await execFileAsync(
      "git",
      ["-C", repoPath, "branch", "-D", branch],
      { encoding: "utf8" },
    ).catch(() => undefined);
  }
}
```

- [ ] **Step 4: Wire the new helper into `dispatchRun`**

In `dispatchRun`, replace the worktree-creation block and record the branch/baseSha on the run. Change these pieces:

Replace the `let worktreeCreated = false;` block's worktree creation:

```ts
  let worktreeCreated = false;
  let runBranch: string | null = null;
  let child: ChildProcess | undefined;
  let runningChild: RunningChild | undefined;
  try {
    await mkdir(paths.runDir, { recursive: true });
    let branch: string | null = null;
    let baseSha: string | null = null;
    if (phase !== "spec_draft") {
      await mkdir(`${board.repoPath}/.tosin4dev/worktrees`, { recursive: true });
      const created = await createRunBranch(
        board.repoPath, paths.workDir, board.defaultBaseBranch, runId,
      );
      branch = created.branch;
      baseSha = created.baseSha;
      runBranch = branch;
      worktreeCreated = true;
      await database.collection<RunDoc>("runs").updateOne(
        { _id: new ObjectId(runId) },
        { $set: { branch, baseSha } },
      );
    }
```

Update the two cleanup call sites to pass the branch:

```ts
    if (worktreeCreated) await removeUnusedWorktree(board.repoPath, paths.workDir, runBranch);
```

Add `branch` and `baseSha` to the `run: RunDoc` object built earlier (both `null` at insert; they are set after worktree creation):

```ts
    branch: null,
    baseSha: null,
    verdict: null,
    failureKind: null,
```

And extend the `RunDoc` type near the top of the file so the new fields typecheck:

```ts
type RunDoc = Run & {
  pid: number | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};
```
(`Run` now already includes `branch`/`baseSha`/`verdict`/`failureKind` from Task 3, so no change is needed here beyond confirming it compiles.)

- [ ] **Step 5: Run tests**

Run: `bunx vitest run src/server/worktree.smoke.test.ts && bun run typecheck`
Expected: PASS + typecheck clean. (`removeUnusedWorktree`'s old 2-arg call site inside the setup-failure path must now pass `runBranch`; fix any remaining call.)

- [ ] **Step 6: Commit**

```bash
git add src/server/supervisor.server.ts src/server/worktree.smoke.test.ts
git commit -m "feat: named per-run worktree branch + base sha"
```

---

## Task 5: Verification module

Given a run's worktree, board checks, base SHA, and branch, decide `passed`/`failed`: require a reachable new commit on the branch, then run each check via `execFile` (argv, no shell) in the worktree, capturing each check's exit code and output to a log file. Split the pure verdict logic from the git/exec side effects so the verdict is unit-tested and the integration is smoke-tested.

**Files:**
- Create: `src/server/verify.server.ts`
- Test: `src/server/verify.test.ts` (pure verdict), `src/server/verify.smoke.test.ts` (git integration)

- [ ] **Step 1: Write the failing pure-verdict test**

Create `src/server/verify.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { verdictFrom } from "./verify.server";

describe("verdictFrom", () => {
  it("fails when there is no new commit", () => {
    expect(verdictFrom(false, [])).toEqual({ verdict: "failed", failureKind: "no_commit" });
  });
  it("fails when any check is nonzero", () => {
    expect(
      verdictFrom(true, [{ key: "t", command: [], exitCode: 1, outputRef: "x", passedAt: "t" }]),
    ).toEqual({ verdict: "failed", failureKind: "verification_failed" });
  });
  it("passes with a commit and all checks zero", () => {
    expect(
      verdictFrom(true, [{ key: "t", command: [], exitCode: 0, outputRef: "x", passedAt: "t" }]),
    ).toEqual({ verdict: "passed", failureKind: null });
  });
  it("passes with a commit and no checks configured", () => {
    expect(verdictFrom(true, [])).toEqual({ verdict: "passed", failureKind: null });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/server/verify.test.ts`
Expected: FAIL — module `./verify.server` not found.

- [ ] **Step 3: Implement the module**

Create `src/server/verify.server.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Board, Evidence } from "../domain/schemas";

const execFileAsync = promisify(execFile);
const CHECK_OUTPUT_CAP = 256_000;

type CheckResult = Evidence["checks"][number];
type Verdict = { verdict: "passed" | "failed"; failureKind: "no_commit" | "verification_failed" | null };

// Pure decision: a run is verified iff it produced a reachable new commit AND
// every configured acceptance check exited 0. No checks configured => a commit
// alone passes (still strictly better than v1's "exit 0 = done").
export function verdictFrom(hasNewCommit: boolean, checks: CheckResult[]): Verdict {
  if (!hasNewCommit) return { verdict: "failed", failureKind: "no_commit" };
  if (checks.some((c) => c.exitCode !== 0)) {
    return { verdict: "failed", failureKind: "verification_failed" };
  }
  return { verdict: "passed", failureKind: null };
}

// Is there at least one commit on `branch` beyond `baseSha`? Empty output from
// rev-list means no new commit — the runner claimed done but committed nothing.
async function hasNewCommit(repoPath: string, baseSha: string, branch: string): Promise<{ has: boolean; tip: string }> {
  const tip = (
    await execFileAsync("git", ["-C", repoPath, "rev-parse", branch], { encoding: "utf8" })
  ).stdout.trim();
  const revs = (
    await execFileAsync("git", ["-C", repoPath, "rev-list", `${baseSha}..${branch}`], { encoding: "utf8" })
  ).stdout.trim();
  return { has: revs.length > 0, tip };
}

async function runCheck(
  check: Board["checks"][number],
  workDir: string,
  outDir: string,
  at: string,
): Promise<CheckResult> {
  const outputRef = `${outDir}/${check.key}.log`;
  let exitCode = 0;
  let output = "";
  try {
    const { stdout, stderr } = await execFileAsync(
      check.command[0],
      check.command.slice(1),
      { cwd: workDir, encoding: "utf8", timeout: check.timeoutMs, maxBuffer: CHECK_OUTPUT_CAP },
    );
    output = stdout + stderr;
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    exitCode = typeof e.code === "number" ? e.code : 1;
    output = `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}`;
  }
  await writeFile(outputRef, output.slice(-CHECK_OUTPUT_CAP));
  return { key: check.key, command: check.command, exitCode, outputRef, passedAt: at };
}

// Verify a finished execute run. Runs in the worktree; writes per-check logs
// under `<runDir>/checks/`. Returns the Evidence payload (minus ids/verdict
// wiring, which the supervisor stamps) plus the computed verdict.
export async function verifyRun(params: {
  repoPath: string;
  workDir: string;
  runDir: string;
  branch: string;
  baseSha: string;
  checks: Board["checks"];
  at: string;
}): Promise<{ commitSha: string; commitRef: string; checks: CheckResult[]; verdict: Verdict["verdict"]; failureKind: Verdict["failureKind"] }> {
  const { has, tip } = await hasNewCommit(params.repoPath, params.baseSha, params.branch);
  const outDir = `${params.runDir}/checks`;
  await mkdir(outDir, { recursive: true });
  const results: CheckResult[] = [];
  if (has) {
    for (const check of params.checks) {
      results.push(await runCheck(check, params.workDir, outDir, params.at));
    }
  }
  const { verdict, failureKind } = verdictFrom(has, results);
  return { commitSha: tip, commitRef: params.branch, checks: results, verdict, failureKind };
}
```

- [ ] **Step 4: Run the pure test**

Run: `bunx vitest run src/server/verify.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the git-integration smoke test**

Create `src/server/verify.smoke.test.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyRun } from "./verify.server";

const exec = promisify(execFile);

async function initRepo(): Promise<{ repo: string; baseSha: string }> {
  const repo = await mkdtemp(join(tmpdir(), "t4d-vf-"));
  await exec("git", ["-C", repo, "init", "-b", "main"]);
  await exec("git", ["-C", repo, "config", "user.email", "t@t"]);
  await exec("git", ["-C", repo, "config", "user.name", "t"]);
  await exec("git", ["-C", repo, "commit", "--allow-empty", "-m", "root"]);
  const baseSha = (await exec("git", ["-C", repo, "rev-parse", "main"])).stdout.trim();
  return { repo, baseSha };
}

describe("verifyRun", () => {
  let repo: string; let baseSha: string; let workDir: string;
  beforeEach(async () => {
    ({ repo, baseSha } = await initRepo());
    workDir = join(repo, ".t4d/wt");
    await exec("git", ["-C", repo, "worktree", "add", "-b", "tosin4dev/run/r", workDir, "main"]);
  });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  it("fails with no_commit when the worktree has no new commit", async () => {
    const res = await verifyRun({
      repoPath: repo, workDir, runDir: join(repo, ".t4d/runs/r"),
      branch: "tosin4dev/run/r", baseSha, checks: [], at: "2026-07-22T00:00:00.000Z",
    });
    expect(res.verdict).toBe("failed");
    expect(res.failureKind).toBe("no_commit");
  });

  it("passes when a commit exists and the check exits 0", async () => {
    await writeFile(join(workDir, "f.txt"), "x");
    await exec("git", ["-C", workDir, "add", "."]);
    await exec("git", ["-C", workDir, "commit", "-m", "work"]);
    const res = await verifyRun({
      repoPath: repo, workDir, runDir: join(repo, ".t4d/runs/r"),
      branch: "tosin4dev/run/r", baseSha,
      checks: [{ key: "true", label: "true", command: ["git", "--version"], timeoutMs: 10000 }],
      at: "2026-07-22T00:00:00.000Z",
    });
    expect(res.verdict).toBe("passed");
    expect(res.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.checks[0].exitCode).toBe(0);
  });

  it("fails verification when a check exits nonzero", async () => {
    await writeFile(join(workDir, "f.txt"), "x");
    await exec("git", ["-C", workDir, "add", "."]);
    await exec("git", ["-C", workDir, "commit", "-m", "work"]);
    const res = await verifyRun({
      repoPath: repo, workDir, runDir: join(repo, ".t4d/runs/r"),
      branch: "tosin4dev/run/r", baseSha,
      checks: [{ key: "fail", label: "fail", command: ["git", "rev-parse", "nope-nope"], timeoutMs: 10000 }],
      at: "2026-07-22T00:00:00.000Z",
    });
    expect(res.verdict).toBe("failed");
    expect(res.failureKind).toBe("verification_failed");
    expect(res.checks[0].exitCode).not.toBe(0);
  });
});
```

- [ ] **Step 6: Run the smoke test**

Run: `bunx vitest run src/server/verify.smoke.test.ts`
Expected: PASS (all three).

- [ ] **Step 7: Commit**

```bash
bun run typecheck
git add src/server/verify.server.ts src/server/verify.test.ts src/server/verify.smoke.test.ts
git commit -m "feat: run verification module (reachable commit + acceptance checks)"
```

---

## Task 6: Gate `review_ready` on verification in `finishRun`

Wire verification into the run-completion path. A nonzero runner exit still fails immediately (`failureKind: "runner_exit"`). On exit 0 for an execute/review_fix run, set the run `verifying`, run `verifyRun`, persist `Evidence`, and only emit `run_succeeded` when the verdict is `passed`; otherwise emit `run_failed` with the verdict's `failureKind`. `spec_draft` is unchanged (no verification). The board is loaded for its `checks`.

**Files:**
- Modify: `src/server/supervisor.server.ts` (`finishRun`, thread `board`/`runDir` through `monitorChild`/`dispatchRun`)
- Modify: `src/server/supervisor.smoke.test.ts` (commit-capable runner; fix the two execute-path tests the gate flips)
- Create: `src/server/verify.finish.smoke.test.ts` (DB-backed, drives the real `dispatchRun` path)

- [ ] **Step 1: Write the failing gate test (full, concrete)**

Create `src/server/verify.finish.smoke.test.ts`. It drives the real `dispatchRun` execute path against a temp git repo and a fake `claude` runner that optionally commits:

```ts
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Collection, Db } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Board, Run, Ticket } from "../domain/schemas";

type BoardDoc = Board & { createdAt: string; updatedAt: string };
type TicketDoc = Ticket & { createdAt: string; updatedAt: string };
type RunDoc = Run & { pid: number | null; queuedAt: string; startedAt: string | null; finishedAt: string | null };
type EvidenceDoc = { runId: string; verdict: string; commitSha: string };

const TEST_DB = `tosin4dev-test-verify-${process.pid}-${Date.now()}`;
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;
process.env.DISCORD_WEBHOOK_URL = "";

const { db, closeDb, ObjectId } = await import("./db");
const { dispatchRun } = await import("./supervisor.server");

let database: Db;
let boards: Collection<BoardDoc>;
let tickets: Collection<TicketDoc>;
let runs: Collection<RunDoc>;
let evidence: Collection<EvidenceDoc>;
let repo: string;
let binDirectory: string;
let boardId: string;

const timestamp = () => new Date().toISOString();

async function writeRunner(commit: boolean, exitCode = 0): Promise<void> {
  const commitBody = commit
    ? `echo "artifact $$" > artifact.txt\ngit add -A\ngit commit -m "work" >/dev/null 2>&1\n`
    : "";
  const exe = join(binDirectory, "claude");
  await writeFile(
    exe,
    `#!/bin/sh\nprintf '%s\\n' 'out'\nprintf '%s\\n' '## SUMMARY'\nprintf '%s\\n' 'ok'\n${commitBody}exit ${exitCode}\n`,
  );
  await chmod(exe, 0o755);
}

async function seedBoard(checks: Board["checks"]): Promise<void> {
  const at = timestamp();
  const b = await boards.insertOne({
    slug: `verify-${process.pid}-${Date.now()}`, name: "Verify", repoPath: repo,
    defaultBaseBranch: "main", checks, createdAt: at, updatedAt: at,
  });
  boardId = b.insertedId.toString();
}

async function insertApproved(seq: number): Promise<string> {
  const at = timestamp();
  const r = await tickets.insertOne({
    boardId, seq, title: `verify ${seq}`, type: "implement", status: "approved", runner: "claude",
    spec: { intent: "verify", scope: "", nonGoals: "", acceptance: [], links: [], risk: "low", approvedAt: at, approvedBy: "radan" },
    activeRunId: null, prUrl: null, activity: [], createdAt: at, updatedAt: at,
  });
  return r.insertedId.toString();
}

async function waitForRun(runId: string, expected: Run["status"], timeoutMs = 15_000): Promise<RunDoc> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await runs.findOne({ _id: new ObjectId(runId) });
    if (run?.status === expected) return run;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} did not reach ${expected}`);
}

describe("verification gate", () => {
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "t4d-vrepo-"));
    binDirectory = await mkdtemp(join(tmpdir(), "t4d-vbin-"));
    execFileSync("git", ["init", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    await writeFile(join(repo, "README.md"), "x\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "init"]);
    process.env.PATH = `${binDirectory}:${ORIGINAL_PATH ?? ""}`;
    database = await db();
    boards = database.collection<BoardDoc>("boards");
    tickets = database.collection<TicketDoc>("tickets");
    runs = database.collection<RunDoc>("runs");
    evidence = database.collection<EvidenceDoc>("evidence");
  });

  beforeEach(async () => {
    process.env.PATH = `${binDirectory}:${ORIGINAL_PATH ?? ""}`;
    await tickets.deleteMany({});
    await runs.deleteMany({});
    await evidence.deleteMany({});
    await boards.deleteMany({});
  });

  afterAll(async () => {
    await database?.dropDatabase();
    await closeDb();
    process.env.PATH = ORIGINAL_PATH;
    process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;
    process.env.DISCORD_WEBHOOK_URL = ORIGINAL_WEBHOOK;
    await Promise.all([
      rm(repo, { recursive: true, force: true }),
      rm(binDirectory, { recursive: true, force: true }),
    ]);
  });

  it("passes to review_ready with Evidence when the runner commits and checks pass", async () => {
    await seedBoard([{ key: "v", label: "v", command: ["git", "--version"], timeoutMs: 10_000 }]);
    await writeRunner(true);
    const ticketId = await insertApproved(1);
    const { runId } = await dispatchRun(ticketId, "execute");
    const run = await waitForRun(runId, "succeeded");
    const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
    expect(ticket?.status).toBe("review_ready");
    expect(run.verdict).toBe("passed");
    const ev = await evidence.findOne({ runId });
    expect(ev?.verdict).toBe("passed");
    expect(ev?.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("blocks with failureKind no_commit when the runner exits 0 but commits nothing", async () => {
    await seedBoard([]);
    await writeRunner(false);
    const ticketId = await insertApproved(2);
    const { runId } = await dispatchRun(ticketId, "execute");
    const run = await waitForRun(runId, "failed");
    const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
    expect(ticket?.status).toBe("blocked");
    expect(run.failureKind).toBe("no_commit");
    expect((await evidence.findOne({ runId }))?.verdict).toBe("failed");
  });

  it("blocks with failureKind verification_failed when a check fails", async () => {
    await seedBoard([{ key: "bad", label: "bad", command: ["git", "rev-parse", "no-such-ref"], timeoutMs: 10_000 }]);
    await writeRunner(true);
    const ticketId = await insertApproved(3);
    const { runId } = await dispatchRun(ticketId, "execute");
    const run = await waitForRun(runId, "failed");
    const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
    expect(ticket?.status).toBe("blocked");
    expect(run.failureKind).toBe("verification_failed");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/server/verify.finish.smoke.test.ts`
Expected: FAIL — the un-gated `finishRun` marks the no-commit run `succeeded`/`review_ready`, and no `evidence` doc is written, so the assertions fail.

- [ ] **Step 3: Rework `finishRun`**

In `src/server/supervisor.server.ts`, import the verifier and Evidence type at the top:

```ts
import { verifyRun } from "./verify.server";
import { EvidenceSchema, type Evidence } from "../domain/schemas";
```

Replace the execute/review_fix branch of `finishRun` (the block after the `spec_draft` early-return) with a verification-gated version. Add a `board` + `runDir` parameter to `finishRun` (threaded from `dispatchRun`/`monitorChild`), then:

```ts
  // exit != 0: the runner itself failed. No verification — fail fast.
  if (!succeeded) {
    await database.collection<RunDoc>("runs").updateOne(
      { _id: new ObjectId(runId), status: { $in: ["queued", "running", "verifying"] } },
      { $set: { status: "failed", exitCode, summary, failureKind: "runner_exit", finishedAt: now() } },
    );
    await transitionTicketFailed(database, ticketId, runId, `run failed (exit ${exitCode})`);
    await notifyBlocked(database, ticketId, `run failed (exit ${exitCode})`, logFile);
    return;
  }

  // exit 0: Tosin4dev — not the runner — proves the work. Enter `verifying`.
  await database.collection<RunDoc>("runs").updateOne(
    { _id: new ObjectId(runId), status: { $in: ["queued", "running"] } },
    { $set: { status: "verifying" } },
  );
  const run = await database.collection<RunDoc>("runs").findOne({ _id: new ObjectId(runId) });
  const at = now();
  const result = await verifyRun({
    repoPath: board.repoPath,
    workDir: run!.workDir,
    runDir,
    branch: run!.branch!,
    baseSha: run!.baseSha!,
    checks: board.checks,
    at,
  });
  const evidence: Evidence = EvidenceSchema.parse({
    runId, ticketId,
    commitSha: result.commitSha, commitRef: result.commitRef,
    checks: result.checks, verdict: result.verdict,
  });
  await database.collection("evidence").insertOne({ ...evidence, createdAt: at });

  if (result.verdict === "passed") {
    await database.collection<RunDoc>("runs").updateOne(
      { _id: new ObjectId(runId), status: "verifying" },
      { $set: { status: "succeeded", exitCode, summary, verdict: "passed", finishedAt: at } },
    );
    await transitionTicketSucceeded(database, ticketId, runId, at);
    await notifyReviewReady(database, ticketId, summary);
    return;
  }

  await database.collection<RunDoc>("runs").updateOne(
    { _id: new ObjectId(runId), status: "verifying" },
    { $set: { status: "failed", exitCode, summary, verdict: "failed", failureKind: result.failureKind, finishedAt: at } },
  );
  await transitionTicketFailed(database, ticketId, runId, `verification ${result.failureKind}`);
  await notifyBlocked(database, ticketId, `verification failed (${result.failureKind})`, logFile);
```

Extract the ticket-transition + notify code currently inline in `finishRun` into small local helpers `transitionTicketSucceeded`, `transitionTicketFailed`, `notifyReviewReady`, `notifyBlocked` (they already exist as inline logic — the `updateOne(... status "running" ...)` + `notify(...)` calls; move them verbatim into named functions so both branches reuse them). Both transition helpers must keep the existing `matchedCount === 0` fallback that clears `activeRunId` on a lost race.

Thread the new params through `monitorChild` (add `board: Board`, `runDir: string`) and its call site in `dispatchRun` (pass `board` and `paths.runDir`). No test-only export is needed — the new test drives the real `dispatchRun` path.

- [ ] **Step 4: Fix the two existing execute-path tests the gate now flips**

The verification gate turns any execute run that commits nothing into `blocked`, so the two existing execute tests in `src/server/supervisor.smoke.test.ts` that expect `review_ready` must now use a runner that actually commits. First make the harness runner commit-capable — replace `writeRunner` (around line 38):

```ts
async function writeRunner(lines: readonly string[], exitCode = 0, commit = false): Promise<void> {
  const body = lines.map((line) => `printf '%s\\n' '${line}'`).join("\n");
  const commitBody = commit
    ? `echo "artifact $$" > verify-artifact.txt\ngit add -A\ngit commit -m "runner work" >/dev/null 2>&1\n`
    : "";
  const executable = join(binDirectory, "claude");
  await writeFile(executable, `#!/bin/sh\n${body}\n${commitBody}exit ${exitCode}\n`);
  await chmod(executable, 0o755);
}
```

Then in the two tests that dispatch `"execute"`/`"review_fix"` and expect `review_ready`:
- **"executes end-to-end in a detached worktree"** — rename to `"executes end-to-end on a named run branch"`; add as its first line `await writeRunner(["runner output", "## SUMMARY", "smoke ok"], 0, true);`; keep the `review_ready` assertion and add `expect(run.verdict).toBe("passed");`.
- **"accepts review fixes only from the already-running state"** — add `await writeRunner(["runner output", "## SUMMARY", "smoke ok"], 0, true);` before the `dispatchRun(ticketId, "review_fix")` call (review_fix verifies too); keep the `review_ready` assertion.

The exit-7 test (`"records a failed runner and blocks an execute ticket"`) is unaffected — a nonzero exit still blocks (now `failureKind: "runner_exit"`, which it doesn't assert).

- [ ] **Step 5: Run tests**

Run: `bunx vitest run src/server/verify.finish.smoke.test.ts src/server/supervisor.smoke.test.ts`
Expected: PASS (new gate test green; existing smoke tests green with the committing runner).

- [ ] **Step 6: Full suite + typecheck**

Run: `bun run test && bun run typecheck`
Expected: PASS + clean.

- [ ] **Step 7: Commit**

```bash
git add src/server/supervisor.server.ts src/server/supervisor.smoke.test.ts src/server/verify.finish.smoke.test.ts
git commit -m "feat: gate review_ready on orchestrator-run verification + Evidence"
```

---

## Task 7: Wire boot recovery once

`recoverOrphans` exists but nothing calls it outside tests. Add a `globalThis`-guarded `bootRecoveryOnce()` and invoke it at the start of `dispatchRun`, so a supervisor restart reconciles orphaned runs before it claims new work — matching the lazy-singleton pattern in `db.ts`.

**Files:**
- Modify: `src/server/supervisor.server.ts`
- Test: `src/server/supervisor.smoke.test.ts` (add a case)

- [ ] **Step 1: Write the failing test (full, concrete)**

Add to `src/server/supervisor.smoke.test.ts` (inside the `describe("supervisor smoke", …)` block, so it reuses `runs`/`tickets`/`ObjectId`/`timestamp`/`boardId`/`repo`/`insertTicket`). It proves recovery fires exactly once: an orphan seeded before the first call is recovered; one seeded after is not.

```ts
type BootGlobal = typeof globalThis & { __tosin4devRecovered?: Promise<void> };

async function seedOrphan(seq: number): Promise<{ ticketId: string; runId: import("mongodb").ObjectId }> {
  const ticketId = await insertTicket("running", seq);
  const runId = new ObjectId();
  const at = timestamp();
  await tickets.updateOne({ _id: new ObjectId(ticketId) }, { $set: { activeRunId: runId.toString() } });
  await runs.insertOne({
    _id: runId, ticketId, boardId, runner: "claude", phase: "execute", status: "running",
    workDir: repo, promptFile: join(repo, `p-${seq}.md`), logFile: join(repo, `o-${seq}.log`),
    pid: 2_147_483_647, exitCode: null, summary: null,
    branch: null, baseSha: null, verdict: null, failureKind: null,
    queuedAt: at, startedAt: at, finishedAt: null,
  });
  return { ticketId, runId };
}

it("runs orphan recovery exactly once per process", async () => {
  (globalThis as BootGlobal).__tosin4devRecovered = undefined;
  const { bootRecoveryOnce } = await import("./supervisor.server");

  const first = await seedOrphan(30);
  await bootRecoveryOnce();
  await bootRecoveryOnce(); // second call is a no-op (same cached promise)

  expect((await runs.findOne({ _id: first.runId }))?.status).toBe("failed");
  expect((await tickets.findOne({ _id: new ObjectId(first.ticketId) }))?.status).toBe("blocked");

  // Seeded AFTER the guard resolved -> a later call must NOT recover it.
  const later = await seedOrphan(31);
  await bootRecoveryOnce();
  expect((await runs.findOne({ _id: later.runId }))?.status).toBe("running");

  (globalThis as BootGlobal).__tosin4devRecovered = undefined; // leave the guard clean for other tests
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/server/supervisor.smoke.test.ts -t "orphan recovery exactly once"`
Expected: FAIL — `bootRecoveryOnce` not exported.

- [ ] **Step 3: Implement the guard**

In `src/server/supervisor.server.ts`:

```ts
const globalForBoot = globalThis as typeof globalThis & { __tosin4devRecovered?: Promise<void> };

// Reconcile orphaned runs once per process. Cached on globalThis (not a module
// `let`) so Vite HMR re-evaluation doesn't re-run recovery mid-session, mirroring
// db.ts's singleton. Idempotent by construction — a second caller awaits the
// same promise.
export function bootRecoveryOnce(): Promise<void> {
  if (!globalForBoot.__tosin4devRecovered) {
    globalForBoot.__tosin4devRecovered = recoverOrphans().catch((error) => {
      globalForBoot.__tosin4devRecovered = undefined; // let a later dispatch retry
      throw error;
    });
  }
  return globalForBoot.__tosin4devRecovered;
}
```

At the very top of `dispatchRun`, before the ticket lookup:

```ts
  await bootRecoveryOnce();
```

> Note: the Step 1 test already resets `__tosin4devRecovered` to `undefined` at its start and end, so it exercises a clean first-call regardless of suite ordering and leaves the guard clean for other tests.

- [ ] **Step 4: Run tests**

Run: `bunx vitest run src/server/supervisor.smoke.test.ts && bun run typecheck`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/supervisor.server.ts src/server/supervisor.smoke.test.ts
git commit -m "feat: wire boot orphan-recovery once per process"
```

---

## Task 8: Final verification gate

**Files:** none

- [ ] **Step 1: Full suite + typecheck + build**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run test && bun run typecheck && bun run build && echo GATE_OK
```
Expected: `GATE_OK`. If the build step needs Mongo or fails for a pre-existing reason unrelated to this plan, note it; tests + typecheck are the hard gates.

- [ ] **Step 2: Confirm the differentiator end-to-end (manual, optional)**

With `just db-up` and a board whose `checks` include a failing command, dispatch an execute run on a ticket whose runner makes no commit → confirm the ticket lands in **Blocked** with `failureKind` `no_commit`, and an `evidence` doc with `verdict: "failed"` exists. With a runner that commits and passes checks → confirm **Review Ready** and `verdict: "passed"`. This is the false-success defect, closed.

- [ ] **Step 3: Commit any doc/cleanup**

```bash
git add -A && git commit -m "chore: verification kernel slice complete" || echo "nothing to commit"
```

---

## Self-review notes

- **Spec coverage:** reachable named commit (T4), orchestrator-run acceptance checks (T1 config, T5 module, T6 gate), Evidence (T2, T6), typed failure distinction `runner_exit`/`no_commit`/`verification_failed` (T3, T6), boot recovery wired (T7). Command safety = argv `execFile`, no shell (T5).
- **Deferred (own sub-plan):** full `Run→Turn`/`EventJournal`/lease/idempotency rework, `waiting_dependency`/`permission_required`/retry taxonomy, ChatSession/SpecBundle/adapters, board-checks editing UI (config seeded directly for now), `HUMAN_GATES` change (only matters once `needs_input` exists).
- **Type consistency:** `failureKind` values identical in schema (T3) and module/gate (T5/T6); `verdict` enum shared; `runBranchName(runId)` is the single branch-name source (T4) reused by tests.
- **Known looseness:** the `evidence` collection is written with `insertOne({...evidence, createdAt})` without a dedicated index — acceptable for v1 local scale; add an index when Evidence is queried independently.
