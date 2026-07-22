# Durable Turns / Needs Input — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** An autonomous run can pause to ask the human a decision (`needs_input`) and resume on the answer in the same worktree/session — on top of the shipped verification kernel.

**Architecture:** The execute/review_fix runner writes `<runDir>/outcome.json` (`completed|needs_input|failed`); the supervisor reads it (fail-closed), captures the provider session id from structured output, and either runs the existing verification gate (`completed`), parks the ticket in a new `needs_input` state keeping its `activeRunId` (`needs_input`), or blocks (`failed`). `provideInput(ticketId, answer)` resumes the same run's session in the same worktree.

**Tech Stack:** Bun, TanStack Start, mongodb + Zod, Vitest, `node:child_process`, git worktrees.

Spec: `docs/superpowers/specs/2026-07-22-durable-turns-needs-input-design.md`.

**Conventions:** run from repo root `/home/radan/Projects/Tosin4dev/tosin4dev`; `export PATH="$HOME/.bun/bin:$PATH"`; tests `bunx vitest run <file>`; gate `bun run test && bun run typecheck`; Mongo must be up (`just db-up`). Commit after each task. Follow existing patterns (`ServerResultError`, `boundary`, `now()`, `execFileAsync`, react-query-kit).

---

## Task 0: Baseline

- [ ] **Step 1:** `export PATH="$HOME/.bun/bin:$PATH" && bun install && just db-up && bun run test && bun run typecheck` → all green (14 files / 120 tests as of slice A). Note any pre-existing failure before starting.

---

## Task 1: Domain — outcome schema, needs_input status, run fields

**Files:** Modify `src/domain/schemas.ts`; Test `src/domain/schemas.test.ts`. Also fix run-doc literals in `src/server/supervisor.server.ts` + `src/server/supervisor.smoke.test.ts` (the new required Run fields ripple).

- [ ] **Step 1: failing test** — add to `src/domain/schemas.test.ts`:

```ts
import { RunOutcomeSchema, TicketStatus, RunStatus, RunSchema } from "./schemas";

describe("slice B domain", () => {
  it("parses a needs_input outcome with a question", () => {
    const o = RunOutcomeSchema.parse({ outcome: "needs_input", question: "Which auth lib?" });
    expect(o.outcome).toBe("needs_input");
    expect(o.question).toBe("Which auth lib?");
  });
  it("rejects an unknown outcome", () => {
    expect(() => RunOutcomeSchema.parse({ outcome: "maybe" })).toThrow();
  });
  it("adds needs_input ticket status and awaiting_input run status", () => {
    expect(TicketStatus.parse("needs_input")).toBe("needs_input");
    expect(RunStatus.parse("awaiting_input")).toBe("awaiting_input");
  });
  it("defaults new run fields to null", () => {
    const run = RunSchema.parse({
      ticketId: "a".repeat(24), boardId: "b".repeat(24), runner: "claude",
      phase: "execute", status: "queued",
      workDir: "/r/.tosin4dev/worktrees/x", promptFile: "/r/.tosin4dev/runs/x/prompt.md",
      logFile: "/r/.tosin4dev/runs/x/output.log",
    });
    expect(run.executionSessionId).toBeNull();
    expect(run.awaitingQuestion).toBeNull();
  });
});
```

- [ ] **Step 2:** `bunx vitest run src/domain/schemas.test.ts -t "slice B domain"` → FAIL.

- [ ] **Step 3: implement** in `src/domain/schemas.ts`:
  - Add `"needs_input"` to `TicketStatus` (after `"running"`).
  - Add `"awaiting_input"` to `RunStatus` (after `"running"`).
  - Extend the `failureKind` enum in `RunSchema` to `["runner_exit", "no_commit", "verification_failed", "runner_reported_failure"]`.
  - Add to `RunSchema` (after `failureKind`):
    ```ts
      // Provider conversation id captured from the runner's structured output, so
      // a later turn can resume the SAME session. null for legacy/uncaptured runs.
      executionSessionId: z.string().nullable().default(null),
      // The question a `needs_input` run is parked on; null otherwise.
      awaitingQuestion: z.string().nullable().default(null),
    ```
  - Add the outcome contract (after `RunSchema`/`Run`):
    ```ts
    // The structured outcome an execute/review_fix runner writes to
    // <runDir>/outcome.json to declare a semantic result. Missing/invalid is
    // treated as `failed` by the supervisor (fail-closed).
    export const RunOutcomeSchema = z.object({
      outcome: z.enum(["completed", "needs_input", "failed"]),
      question: z.string().nullable().default(null),
      reason: z.string().nullable().default(null),
      summary: z.string().nullable().default(null),
    });
    export type RunOutcome = z.infer<typeof RunOutcomeSchema>;
    ```

- [ ] **Step 4:** `bunx vitest run src/domain/schemas.test.ts -t "slice B domain"` → PASS.

- [ ] **Step 5: fix rippled run literals.** `bun run typecheck` will flag `RunDoc` literals missing the two new fields. Add `executionSessionId: null,` and `awaitingQuestion: null,` to:
  - the `run: RunDoc` object in `dispatchRun` (`src/server/supervisor.server.ts`, alongside `branch: null, baseSha: null, …`),
  - both `runs.insertOne({...})` literals **and** the `seedOrphan` helper literal in `src/server/supervisor.smoke.test.ts`.
  Then re-run `bun run typecheck` and fix any other flagged Run literal the same way.

- [ ] **Step 6:** `bun run typecheck` clean; `bunx vitest run` green. Commit:
```bash
git add src/domain/schemas.ts src/domain/schemas.test.ts src/server/supervisor.server.ts src/server/supervisor.smoke.test.ts
git commit -m "feat: run outcome schema + needs_input state + run session fields"
```

---

## Task 2: State machine — needs_input events + transitions

**Files:** Modify `src/domain/stateMachine.ts`; Test `src/domain/stateMachine.test.ts`.

- [ ] **Step 1: failing test** — add to `src/domain/stateMachine.test.ts`:

```ts
import { transition, HUMAN_GATES, PublicEventSchema } from "./stateMachine";

describe("needs_input edges", () => {
  it("running --run_needs_input--> needs_input", () => {
    expect(transition("running", "run_needs_input")).toBe("needs_input");
  });
  it("needs_input --provide_input--> running", () => {
    expect(transition("needs_input", "provide_input")).toBe("running");
  });
  it("needs_input is a human gate", () => {
    expect(HUMAN_GATES).toContain("needs_input");
  });
  it("provide_input is public but run_needs_input is not", () => {
    expect(PublicEventSchema.safeParse("provide_input").success).toBe(true);
    expect(PublicEventSchema.safeParse("run_needs_input").success).toBe(false);
  });
});
```

- [ ] **Step 2:** run it → FAIL.

- [ ] **Step 3: implement** in `src/domain/stateMachine.ts`:
  - `HUMAN_GATES`: `["spec_review", "review_ready", "needs_input"]`.
  - `EventSchema`: add `"run_needs_input"` and `"provide_input"` to the enum.
  - `PublicEventSchema`: extend the exclude list to `["dispatch", "run_succeeded", "run_failed", "run_needs_input"]` (so `provide_input` stays public, `run_needs_input` does not).
  - `TABLE`: add `"running:run_needs_input": "needs_input"` and `"needs_input:provide_input": "running"`.

- [ ] **Step 4:** run it → PASS. `bunx vitest run src/domain/stateMachine.test.ts` all green.

- [ ] **Step 5:** `bun run typecheck` clean. Commit:
```bash
git add src/domain/stateMachine.ts src/domain/stateMachine.test.ts
git commit -m "feat: needs_input state machine events + transitions"
```

---

## Task 3: Runner contract — structured output, outcome instruction, resume

**Files:** Modify `src/runners/types.ts`, `src/runners/brief.ts`, `src/runners/claude.ts`, `src/runners/codex.ts`; Tests `src/runners/brief.test.ts`, `src/runners/adapters.test.ts` (new).

- [ ] **Step 1: extend `RunnerBrief`** in `src/runners/types.ts`:
```ts
export interface RunnerBrief {
  ticket: Ticket;
  board: Board;
  workDir: string;
  phase: Run["phase"];
  // Absolute path the runner must write its outcome JSON to (execute/review_fix).
  outcomePath?: string;
  // Present on a resume turn: the captured session id + the human's answer.
  resume?: { sessionId: string; answer: string };
}
```

- [ ] **Step 2: brief test** — add to `src/runners/brief.test.ts` a case asserting the execute brief mentions the outcome file and, on resume, the answer:
```ts
it("instructs the runner to write outcome.json on execute", () => {
  const text = buildPrompt({ ticket, board, workDir: "/wt", phase: "execute", outcomePath: "/r/outcome.json" });
  expect(text).toContain("/r/outcome.json");
  expect(text).toContain('"outcome"');
});
it("carries the human answer on a resume turn", () => {
  const text = buildPrompt({ ticket, board, workDir: "/wt", phase: "execute", outcomePath: "/r/outcome.json", resume: { sessionId: "s1", answer: "use lucia" } });
  expect(text).toContain("use lucia");
});
```
(Reuse the `ticket`/`board` fixtures already at the top of `brief.test.ts`.)

- [ ] **Step 3:** run → FAIL.

- [ ] **Step 4: implement `buildPrompt`** (`src/runners/brief.ts`). Keep `spec_draft` unchanged. For the execute/review_fix return, append two blocks:
  - a resume preface when `brief.resume` is set:
    ```ts
    const resumePreface = brief.resume
      ? `You previously paused to ask a question. The human answered:\n${brief.resume.answer}\nContinue from where you left off under the SAME locked spec.`
      : null;
    ```
  - an outcome-contract instruction (always, for execute/review_fix), replacing the current "End your output with a section titled SUMMARY…" line:
    ```ts
    `When you finish, write this JSON to ${brief.outcomePath ?? "<runDir>/outcome.json"} and nothing else to it:`,
    `{"outcome":"completed|needs_input|failed","question":"<required if needs_input>","reason":"<optional>","summary":"<=10 lines"}`,
    `Use "needs_input" ONLY for a genuine decision you cannot make under the locked spec; put the exact question in "question". Use "completed" when the work is done and committed; "failed" if you cannot proceed. Do not ask for confirmation of work you can just do.`,
    ```
  Assemble with `resumePreface` first (if present) via `[resumePreface, ...lines].filter(Boolean).join("\n\n")`.

- [ ] **Step 5: adapters test** — create `src/runners/adapters.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import type { RunnerBrief } from "./types";

const brief = (over: Partial<RunnerBrief> = {}): RunnerBrief =>
  ({ ticket: {} as never, board: {} as never, workDir: "/wt", phase: "execute", outcomePath: "/wt/o.json", ...over });

describe("claude adapter", () => {
  it("uses json output on execute (for session capture)", () => {
    const c = claudeAdapter.buildCommand(brief(), "/p.md");
    expect(c.cmd).toContain("--output-format");
    expect(c.cmd).toContain("json");
  });
  it("adds --resume with the session id on a resume turn", () => {
    const c = claudeAdapter.buildCommand(brief({ resume: { sessionId: "s1", answer: "x" } }), "/p.md");
    expect(c.cmd).toContain("--resume");
    expect(c.cmd).toContain("s1");
  });
});
describe("codex adapter", () => {
  it("uses --json on execute", () => {
    const c = codexAdapter.buildCommand(brief(), "/p.md");
    expect(c.cmd).toContain("--json");
  });
  it("uses exec resume <thread> on a resume turn", () => {
    const c = codexAdapter.buildCommand(brief({ resume: { sessionId: "t1", answer: "x" } }), "/p.md");
    expect(c.cmd).toContain("resume");
    expect(c.cmd).toContain("t1");
  });
});
```

- [ ] **Step 6:** run → FAIL.

- [ ] **Step 7: implement adapters.** `src/runners/claude.ts`:
```ts
import type { RunnerAdapter } from "./types";

export const claudeAdapter: RunnerAdapter = {
  name: "claude",
  buildCommand(brief, promptFile) {
    // spec_draft keeps plain text + the SUMMARY section; execute/review_fix use
    // JSON output so the supervisor can capture the session id.
    if (brief.phase === "spec_draft") {
      return { cmd: ["claude", "-p", `Read ${promptFile} and follow it exactly. End with the required SUMMARY section.`, "--output-format", "text"], env: {} };
    }
    const prompt = brief.resume
      ? `Read ${promptFile} and follow it exactly. It contains the human's answer to your question. Finish by writing the outcome JSON.`
      : `Read ${promptFile} and follow it exactly. Finish by writing the outcome JSON.`;
    const cmd = ["claude", "-p", prompt, "--output-format", "json"];
    if (brief.resume) cmd.push("--resume", brief.resume.sessionId);
    return { cmd, env: {} };
  },
};
```
`src/runners/codex.ts`:
```ts
import type { RunnerAdapter } from "./types";

export const codexAdapter: RunnerAdapter = {
  name: "codex",
  buildCommand({ workDir, phase, resume }, promptFile) {
    const sandbox = phase === "spec_draft" ? "read-only" : "workspace-write";
    const prompt = `Read ${promptFile} and follow it exactly.${phase === "spec_draft" ? " End with the required SUMMARY section." : " Finish by writing the outcome JSON."}`;
    // cwd + sandbox are ROOT-level flags (before `exec`) — required for `exec resume`.
    const root = ["codex", "-C", workDir, "-s", sandbox];
    if (resume) {
      return { cmd: [...root, "exec", "resume", resume.sessionId, "--json", prompt], env: {} };
    }
    return { cmd: [...root, "exec", "--json", prompt], env: {} };
  },
};
```
(Note: cwd/sandbox move to root-level flags for both fresh and resume so the two paths are symmetric; the supervisor still sets `cwd` on spawn.)

- [ ] **Step 8:** `bunx vitest run src/runners/` → all green. `bun run typecheck` clean. Commit:
```bash
git add src/runners/
git commit -m "feat: runner outcome contract + structured output + resume commands"
```

---

## Task 4: Supervisor read-side helpers — session id + outcome

**Files:** Create `src/server/outcome.server.ts`; Test `src/server/outcome.test.ts`, `src/server/outcome.smoke.test.ts`.

- [ ] **Step 1: unit test** — `src/server/outcome.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseSessionId } from "./outcome.server";

describe("parseSessionId", () => {
  it("reads session_id from claude json result", () => {
    expect(parseSessionId("claude", '{"type":"result","session_id":"abc-123","result":"ok"}')).toBe("abc-123");
  });
  it("reads thread_id from codex thread.started event", () => {
    const jsonl = '{"type":"thread.started","thread_id":"019f-xyz"}\n{"type":"turn.completed"}';
    expect(parseSessionId("codex", jsonl)).toBe("019f-xyz");
  });
  it("returns null when absent or unparseable", () => {
    expect(parseSessionId("claude", "not json")).toBeNull();
    expect(parseSessionId("codex", "{}")).toBeNull();
  });
});
```

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: implement** `src/server/outcome.server.ts`:
```ts
import { readFile } from "node:fs/promises";
import { RunOutcomeSchema, type RunOutcome } from "../domain/schemas";

// Extract the provider session/thread id from a runner's structured stdout.
// claude --output-format json emits one JSON object carrying `session_id`;
// codex --json emits JSONL whose `thread.started` event carries `thread_id`.
// Returns null if not found (resume will then be unavailable — safe).
export function parseSessionId(runner: "claude" | "codex", stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let obj: unknown;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (!obj || typeof obj !== "object") continue;
    const rec = obj as Record<string, unknown>;
    if (runner === "claude" && typeof rec.session_id === "string") return rec.session_id;
    if (runner === "codex" && rec.type === "thread.started" && typeof rec.thread_id === "string") return rec.thread_id;
  }
  return null;
}

// Read + validate <runDir>/outcome.json. Fail-closed: a missing/invalid/absent
// file yields a `failed` outcome, so a runner that ignores the contract can
// never masquerade as completed.
export async function readOutcome(runDir: string): Promise<RunOutcome> {
  try {
    const raw = await readFile(`${runDir}/outcome.json`, "utf8");
    const parsed = RunOutcomeSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return RunOutcomeSchema.parse({ outcome: "failed", reason: "invalid outcome.json" });
    return parsed.data;
  } catch {
    return RunOutcomeSchema.parse({ outcome: "failed", reason: "no outcome.json written" });
  }
}
```

- [ ] **Step 4:** run → PASS.

- [ ] **Step 5: smoke test** `src/server/outcome.smoke.test.ts` — write a temp `outcome.json` and assert `readOutcome` parses `needs_input`, and that a missing file yields `failed`:
```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOutcome } from "./outcome.server";

describe("readOutcome", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "t4d-oc-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  it("parses a needs_input outcome file", async () => {
    await writeFile(join(dir, "outcome.json"), JSON.stringify({ outcome: "needs_input", question: "Q?" }));
    const o = await readOutcome(dir);
    expect(o.outcome).toBe("needs_input");
    expect(o.question).toBe("Q?");
  });
  it("fails closed when the file is missing", async () => {
    expect((await readOutcome(dir)).outcome).toBe("failed");
  });
});
```

- [ ] **Step 6:** run both outcome tests → green. `bun run typecheck` clean. Commit:
```bash
git add src/server/outcome.server.ts src/server/outcome.test.ts src/server/outcome.smoke.test.ts
git commit -m "feat: outcome + session-id read helpers (fail-closed)"
```

---

## Task 5: finishRun reads the outcome

**Files:** Modify `src/server/supervisor.server.ts`; Test `src/server/needs-input.smoke.test.ts` (new).

- [ ] **Step 1: smoke test** — create `src/server/needs-input.smoke.test.ts`, modeled on `verify.finish.smoke.test.ts` (same Mongo + temp-git + fake-runner harness). The fake `claude` runner must (a) print a JSON line with a `session_id`, (b) write `<repo>/.tosin4dev/runs/<runId>/outcome.json` — but the runner doesn't know `<runId>`; instead have it write the outcome relative to `$PWD` is wrong (cwd is the worktree). **Approach:** the runner writes to a path passed via the prompt is also unknown to a shell fake. So the fake runner reads the outcome path from an env var the test sets, OR writes to a fixed relative path the supervisor also reads. Simplest deterministic approach: the fake runner writes `outcome.json` into the **run dir** by resolving it from an env var `T4D_OUTCOME` that the *test* cannot set per-run either.

  **Chosen deterministic design:** the supervisor passes the outcome path to the runner via the prompt file, and for the smoke test the fake `claude` script writes the outcome by scanning its argv/prompt for the path. Concretely, the fake script greps the prompt file (whose path is `$3`-ish) — too brittle. Instead, make the supervisor ALSO pass the outcome path as an environment variable `T4D_OUTCOME_PATH` to the runner (add it to `command.env` in the adapter or in the spawn env), and the fake runner writes to `$T4D_OUTCOME_PATH`. Add that env in Task 3's adapters (both) and document it. Then the fake runner:
  ```sh
  #!/bin/sh
  printf '%s\n' '{"type":"thread.started","thread_id":"t-smoke"}'   # codex-style id line (or session_id for claude)
  printf '%s\n' '{"type":"result","session_id":"s-smoke","result":"ok"}'
  echo "artifact $$" > artifact.txt; git add -A; git commit -m work >/dev/null 2>&1
  printf '%s' "$T4D_OUTCOME" > "$T4D_OUTCOME_PATH"
  exit 0
  ```
  where the test sets `T4D_OUTCOME` to the JSON body per case. Assert:
  - `T4D_OUTCOME={"outcome":"needs_input","question":"Q?"}` + committing runner → ticket `needs_input`, run `awaiting_input`, `run.awaitingQuestion === "Q?"`, `ticket.activeRunId` still set, `run.executionSessionId === "s-smoke"`.
  - `T4D_OUTCOME={"outcome":"completed"}` + commit + a passing board check → ticket `review_ready`, run `succeeded`.
  - no outcome written (`T4D_OUTCOME=""` and skip the write) → ticket `blocked`, `run.failureKind === "runner_reported_failure"`.

  > Implementer: wire `T4D_OUTCOME_PATH` into the spawn env — in `dispatchRun`/`resumeRun` add `T4D_OUTCOME_PATH: \`${paths.runDir}/outcome.json\`` to the spawn `env` (NOT the adapter, to keep adapters pure). Update the fake runner accordingly. This env var is the test seam; real runners get the path from the prompt.

- [ ] **Step 2:** run → FAIL (finishRun doesn't read outcomes yet).

- [ ] **Step 3: implement.** In `src/server/supervisor.server.ts`:
  - import `readOutcome, parseSessionId` from `./outcome.server`; extend `failVerifiedRun`'s `failureKind` union with `"runner_reported_failure"`.
  - add a helper:
    ```ts
    async function parkTicketNeedsInput(
      database: Db, runId: string, ticketId: string, question: string, summary: string | null, at: string,
    ): Promise<void> {
      await database.collection<RunDoc>("runs").updateOne(
        { _id: new ObjectId(runId), status: { $in: ["queued", "running", "verifying"] } },
        { $set: { status: "awaiting_input", awaitingQuestion: question, summary } },
      );
      const tickets = database.collection<TicketDoc>("tickets");
      const nextStatus = transition("running", "run_needs_input");
      // KEEP activeRunId — the run is parked, not finished; provideInput resumes it.
      await tickets.updateOne(
        { _id: new ObjectId(ticketId), activeRunId: runId, status: "running" },
        { $set: { status: nextStatus, updatedAt: at }, $push: pushActivity("run", `needs input: ${question}`, at) },
      );
    }
    ```
  - In `finishRun`, replace the exit-0 section. After the `if (!succeeded) { … runner_exit … return; }` block and BEFORE the current `verifying` claim, insert:
    ```ts
    // exit 0: capture the session id, then read the runner's declared outcome.
    const runDoc = await runs.findOne({ _id: new ObjectId(runId) });
    const sessionId = runDoc ? parseSessionId(runDoc.runner, stdout) : null;
    if (sessionId) {
      await runs.updateOne({ _id: new ObjectId(runId) }, { $set: { executionSessionId: sessionId } });
    }
    const outcome = await readOutcome(runDir);
    const outSummary = outcome.summary ?? summary;
    if (outcome.outcome === "needs_input") {
      await parkTicketNeedsInput(database, runId, ticketId, outcome.question ?? "(no question provided)", outSummary, now());
      await notify(`⏸️ needs input: ${await ticketLabelPublic(database, ticketId)} — ${outcome.question ?? ""}`);
      return;
    }
    if (outcome.outcome === "failed") {
      const at = now();
      await failVerifiedRun(database, runId, "runner_reported_failure", exitCode, outSummary, at);
      await transitionTicketFailed(database, ticketId, runId, at, `runner reported failure: ${outcome.reason ?? "unspecified"}`);
      await notifyBlocked(database, ticketId, `runner reported failure`, logFile);
      return;
    }
    // outcome.outcome === "completed" → fall through to the existing verification gate.
    ```
    Use `outSummary` in place of `summary` in the existing verification success/fail updates + `notifyReviewReady`. Add a tiny `ticketLabelPublic` = reuse `ticketLabel` (rename not needed — just call `ticketLabel`). (Note `summary` for execute is now `null` from `parseSummary` on JSON stdout; `outcome.summary` carries the human summary. `spec_draft` still uses `parseSummary` and never reaches this block.)

- [ ] **Step 4:** run the new smoke test + `verify.finish.smoke.test.ts` + `supervisor.smoke.test.ts` → all green. If the existing execute smoke tests now fail because their fake runner doesn't write an outcome, update those runners to write `{"outcome":"completed"}` to `$T4D_OUTCOME_PATH` (do NOT weaken assertions — a completed outcome is the correct new precondition for review_ready).

- [ ] **Step 5:** `bun run test && bun run typecheck` → green. Commit:
```bash
git add src/server/supervisor.server.ts src/server/needs-input.smoke.test.ts src/server/verify.finish.smoke.test.ts src/server/supervisor.smoke.test.ts
git commit -m "feat: finishRun reads runner outcome (needs_input parks; completed verifies)"
```

---

## Task 6: resumeRun + provideInput server function

**Files:** Modify `src/server/supervisor.server.ts` (add `resumeRun`), `src/server/tickets.ts`, `src/server/tickets.server.ts`, `src/queries/tickets.ts`; Test extend `src/server/needs-input.smoke.test.ts`.

- [ ] **Step 1: extend the smoke test** — after the `needs_input` case, call `provideInput` and assert the resume completes:
```ts
it("resumes a needs_input ticket and completes on the answer", async () => {
  const { provideInputCore } = await import("./tickets.server");
  // seed board with a passing check; run a needs_input turn (as above) to park the ticket
  // ...ticket is needs_input, run awaiting_input, executionSessionId "s-smoke"...
  // set the runner to now write {"outcome":"completed"} on resume:
  await setRunnerOutcome('{"outcome":"completed","summary":"done"}');
  await provideInputCore({ ticketId, answer: "use lucia" });
  const run = await waitForRun(runId, "succeeded");
  const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
  expect(ticket?.status).toBe("review_ready");
  expect(run.verdict).toBe("passed");
});
```
(Provide a `setRunnerOutcome(body)` helper in the test that rewrites the fake runner + updates the `T4D_OUTCOME` env used by the beforeEach spawn — or set `process.env.T4D_OUTCOME` per case since the supervisor forwards `process.env`.)

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: implement `resumeRun`** in `src/server/supervisor.server.ts` (export it):
```ts
export async function resumeRun(runId: string, answer: string): Promise<void> {
  const database = await db();
  const runs = database.collection<RunDoc>("runs");
  const run = await runs.findOne({ _id: new ObjectId(runId) });
  if (!run || run.status !== "awaiting_input") {
    throw new ServerResultError("conflict", "run is not awaiting input");
  }
  if (!run.executionSessionId) {
    throw new ServerResultError("conflict", "run has no captured session to resume");
  }
  const board = BoardSchema.parse(await database.collection<BoardDoc>("boards").findOne({ _id: new ObjectId(run.boardId) }));
  const ticket = TicketSchema.parse(await database.collection<TicketDoc>("tickets").findOne({ _id: new ObjectId(run.ticketId) }));
  const runDir = `${board.repoPath}/.tosin4dev/runs/${runId}`;
  await rm(`${runDir}/outcome.json`, { force: true }).catch(() => undefined); // clear stale outcome
  const brief: RunnerBrief = {
    ticket, board, workDir: run.workDir, phase: run.phase,
    outcomePath: `${runDir}/outcome.json`,
    resume: { sessionId: run.executionSessionId, answer },
  };
  await writeFile(run.promptFile, buildPrompt(brief));
  const claimed = await runs.updateOne(
    { _id: new ObjectId(runId), status: "awaiting_input" },
    { $set: { status: "running", awaitingQuestion: null, startedAt: now() } },
  );
  if (claimed.matchedCount === 0) throw new ServerResultError("conflict", "run left awaiting_input");
  const command = adapters[run.runner].buildCommand(brief, run.promptFile);
  const spawnedChild = spawn(command.cmd[0], command.cmd.slice(1), {
    cwd: run.workDir,
    env: { ...process.env, ...command.env, T4D_OUTCOME_PATH: `${runDir}/outcome.json` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runningChild: RunningChild = {
    stdout: drainStream(spawnedChild.stdout, run.logFile, true),
    stderr: drainStream(spawnedChild.stderr, run.logFile, false),
    exited: settledExit(spawnedChild),
  };
  void Promise.all([runningChild.stdout, runningChild.stderr, runningChild.exited]).catch(() => undefined);
  await waitForSpawn(spawnedChild);
  await runs.updateOne({ _id: new ObjectId(runId) }, { $set: { pid: spawnedChild.pid } });
  void monitorChild(runningChild, runId, run.ticketId, run.phase, run.logFile, board, runDir)
    .catch((error) => console.error(`resume monitor failed for run ${runId}:`, error));
}
```
Add `rm` to the `node:fs/promises` import. (Also add `T4D_OUTCOME_PATH` to the fresh-dispatch spawn env in `dispatchRun`, per Task 5's note, if not already done.)

- [ ] **Step 4: provideInput core** in `src/server/tickets.server.ts`:
```ts
import { resumeRun } from "./supervisor.server";
// ...
export async function provideInputCore(input: { ticketId: string; answer: string }): Promise<{ status: string }> {
  const coll = await tickets();
  const doc = await coll.findOne({ _id: new ObjectId(input.ticketId) });
  if (!doc) throw new ServerResultError("not_found", `ticket not found: ${input.ticketId}`);
  if (doc.status !== "needs_input") throw new ServerResultError("conflict", "ticket is not awaiting input");
  if (!doc.activeRunId) throw new ServerResultError("conflict", "ticket has no parked run");
  const at = now();
  const to = transition("needs_input", "provide_input");
  const res = await coll.updateOne(
    { _id: doc._id, status: "needs_input" },
    { $set: { status: to, updatedAt: at }, $push: pushActivity("input", `answered: ${input.answer}`, at) },
  );
  if (res.matchedCount === 0) throw new ServerResultError("conflict", "ticket is no longer awaiting input");
  await resumeRun(doc.activeRunId, input.answer);
  return { status: to };
}
```

- [ ] **Step 5: server fn** in `src/server/tickets.ts`:
```ts
export const ProvideInputInputSchema = z
  .object({ ticketId: ObjectIdString, answer: z.string().min(1) })
  .strict();
export const provideInput = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ status: string }>> =>
    boundary(ProvideInputInputSchema, data, provideInputCore),
  );
```
(import `provideInputCore` from `./tickets.server`.)

- [ ] **Step 6: query** — add a `useProvideInput` mutation in `src/queries/tickets.ts` following the existing mutation pattern in that file (read it first; mirror how `transitionTicket`/`updateSpec` are wrapped with react-query-kit + `unwrapResult`, invalidating the ticket/board query on success).

- [ ] **Step 7:** run the extended smoke test + full suite → green. `bun run typecheck` clean. Commit:
```bash
git add src/server/supervisor.server.ts src/server/tickets.ts src/server/tickets.server.ts src/queries/tickets.ts src/server/needs-input.smoke.test.ts
git commit -m "feat: provideInput resumes a needs_input run in the same worktree/session"
```

---

## Task 7: UI — Needs Input column + provide-input box

**Files:** Modify the board route (`src/routes/b/$boardSlug.tsx`), `src/components/TicketCard.tsx`, the ticket detail route (`src/routes/b/$boardSlug/t/$ticketSeq.tsx`); read them first to match patterns.

- [ ] **Step 1:** Read the board route + `TicketCard.tsx` to find the column/status grouping. Add `needs_input` to the ordered column list (label "Needs Input"), placed between Running and Review Ready. Ensure a ticket with `status: "needs_input"` renders in that column. If there's a status→label/color map, add an entry.

- [ ] **Step 2:** Read the ticket detail route. Its runs section already lists runs (`RunsSection`). Add a **Provide input** panel that shows when the ticket status is `needs_input`: read the active run's `awaitingQuestion` (from the runs query already loaded, find the run whose `status === "awaiting_input"`), render the question, a `<textarea>`, and a button that calls the `useProvideInput` mutation with `{ ticketId, answer }`. Disable while pending; show the mutation error inline. Mirror the structure/styling of `GateButtons.tsx` / `RunsSection.tsx`.

- [ ] **Step 3:** `bun run typecheck` clean; `bun run build` succeeds; `bunx vitest run` green (add a small component/logic test only if the file has existing component tests to mirror — otherwise the smoke coverage from Tasks 5–6 is the behavioral gate; note this in the commit).

- [ ] **Step 4:** Commit:
```bash
git add src/routes/b src/components/TicketCard.tsx
git commit -m "feat: Needs Input column + provide-input panel"
```

---

## Task 8: Final gate

- [ ] **Step 1:** `export PATH="$HOME/.bun/bin:$PATH" && bun run test && bun run typecheck && bun run build && echo GATE_OK`.
- [ ] **Step 2 (manual, optional):** board with a passing check + a runner that writes `{"outcome":"needs_input","question":"…"}` → ticket lands in **Needs Input** with the question; answer via the box → run resumes, writes `{"outcome":"completed"}` → **Review Ready** with Evidence. The autonomous pause/resume loop, closed.

---

## Self-Review

- **Spec coverage:** outcome contract (T1 schema, T3 brief, T4 read, T5 gate); session capture + resume (T3 adapters, T4 parseSessionId, T6 resumeRun); needs_input state + human gate (T1, T2); parked run keeps activeRunId (T5 `parkTicketNeedsInput`); provideInput (T6); UI column + box (T7). Fail-closed on missing/invalid outcome (T4 `readOutcome`, T5 failed branch).
- **Ripple pre-empted:** T1 Step 5 fixes the Run-literal ripple (executionSessionId/awaitingQuestion) in `dispatchRun` + smoke literals before typecheck.
- **Green-at-boundary:** each task ends on `typecheck` + targeted tests; T5 explicitly updates existing execute smoke runners to write a `completed` outcome (precondition tightening, not assertion weakening).
- **Type consistency:** `failureKind` union extended identically in schema (T1) + `failVerifiedRun` (T5); `RunOutcome` shape shared T1/T4/T5; `resume: {sessionId, answer}` shape shared T3 adapters/brief + T6.
- **Deferred (not this slice):** full Run→Turn/EventJournal/leases; `permission_required`/`waiting_dependency`; the chat panel/SpecBundle (C/D).
