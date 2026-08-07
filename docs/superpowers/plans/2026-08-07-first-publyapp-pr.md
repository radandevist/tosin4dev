# First PublyApp Ticket-to-Draft-PR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One PublyApp ticket goes from an owner-approved spec to a draft PR without the owner touching a terminal, and the checks it passed mean something.

**Architecture:** Five independent changes to the existing run pipeline. A dispatch preflight refuses boards with no acceptance checks. A `spec_draft` run gains a structured `spec.json` artifact that writes back into its ticket. A pure decision module decides whether a failed verification is worth retrying, and the supervisor's verification branch consults it before giving up. A publish module pushes the verified branch and opens a draft PR.

**Tech Stack:** TypeScript, Bun, vitest, MongoDB (driver, no ODM), Zod at boundaries, `node:child_process` `execFile`, `gh` CLI.

## Global Constraints

- **Design source of truth:** `docs/superpowers/specs/2026-08-07-first-publyapp-pr-design.md`. Where this plan and that spec disagree, the spec wins — report the discrepancy rather than silently choosing.
- **Zod at boundaries.** Anything crossing a process, file, or wire boundary is parsed with a schema. Never trust a shape from disk or from a runner.
- **`ServerResultError` for expected failures.** Anything else that throws becomes an opaque `internal` error with a logged stack. `code` is a free-form snake_case string.
- **Comments explain WHY, not what.** Follow the density of surrounding code.
- **Never `git push --force` or `--force-with-lease`.** Anywhere. For any reason.
- **Never mark a PR ready for review, and never merge one.**
- **No new dependencies.** No `bun install`, no edits to `package.json` or `bun.lock`. Node built-ins and what `src/` already imports.
- **Do not modify `src/domain/stateMachine.ts`.** Every transition this plan needs already exists.
- **Do not modify the containment logic** in `src/server/browse.server.ts` — it was reviewed against 31 escape attempts.
- **Baseline suite:** `bun run typecheck` exits 0; `bun run test` is 48 files / 420 tests on `main` after PR #25 merges, 47/411 before. The suite takes ~3.5 minutes — be patient, do not kill it.
- **Known pre-existing flakes, not yours to fix** (issues #19/#20): `needs-input.smoke.test.ts` and `supervisor.smoke.test.ts` fail intermittently in-suite. If you see 1–2 failures there, re-run once and say so.
- **Every test must answer:** which revert makes this fail, and does it fail on its own `expect`? This codebase has shipped tests that passed while pinning nothing.

---

## File Structure

**Created:**
- `src/domain/fix-loop.ts` — pure retry decision + failure signature. No I/O, so it is unit-testable without Mongo or git.
- `src/domain/fix-loop.test.ts`
- `src/server/draftedSpec.server.ts` — read + validate `<runDir>/spec.json`. Mirrors `outcome.server.ts` exactly.
- `src/server/draftedSpec.test.ts`
- `src/server/publish.server.ts` — push a branch, open a draft PR. `pushBranch` and `openDraftPr` are separate exports so the git half is testable against a local bare repo and the `gh` half is testable as pure argv construction.
- `src/server/publish.test.ts`
- `src/server/publish.smoke.test.ts`
- `src/server/dispatch.preflight.smoke.test.ts`
- `src/server/specApply.smoke.test.ts`
- `src/server/fixLoop.smoke.test.ts`

**Modified:**
- `src/domain/schemas.ts` — `DraftedSpecSchema`; `fixAttempts`, `lastFixSignature`, `prUrl` on `RunSchema`.
- `src/runners/types.ts` — `specPath?: string` on `RunnerBrief`.
- `src/runners/brief.ts` — the `spec_draft` prompt gains the `spec.json` contract.
- `src/server/supervisor.server.ts` — dispatch preflight; `spec_draft` completion branch; verification failure branch; verification success branch.

---

## Task 1: Refuse dispatch when a board has no acceptance checks

**Files:**
- Modify: `src/server/supervisor.server.ts` (inside `dispatchRun`, immediately after `const board = BoardSchema.parse(rawBoard);` — currently line 1933)
- Test: `src/server/dispatch.preflight.smoke.test.ts` (create)

**Interfaces:**
- Consumes: `dispatchRun(rawTicketId: string, rawPhase: Phase): Promise<{ runId: string }>` — existing, unchanged signature.
- Produces: nothing new. Behaviour change only.

**Why:** `verdictFrom` treats an empty `checks` array as "a commit alone passes". On a board with no checks the verification contract degrades to *the agent made a commit*. Refuse to start rather than run an agent whose work nothing will check.

`spec_draft` is exempt: it is read-only, produces no commit, and is never verified.

- [ ] **Step 1: Write the failing test**

Create `src/server/dispatch.preflight.smoke.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

// Point the lazy db() singleton at a throwaway database *before* anything
// triggers a connection. Unique per run so parallel suites never collide.
const TEST_DB = `tosin4dev-test-dispatch-preflight-${process.pid}-${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;

const { db } = await import("./db");
const { dispatchRun } = await import("./supervisor.server");

const CHECK = {
  key: "lint",
  label: "lint",
  command: ["echo", "ok"],
  timeoutMs: 10_000,
};

async function seed(checks: unknown[]): Promise<string> {
  const database = await db();
  await database.collection("boards").deleteMany({});
  await database.collection("tickets").deleteMany({});
  await database.collection("runs").deleteMany({});
  const boardId = new ObjectId();
  await database.collection("boards").insertOne({
    _id: boardId,
    slug: "publyapp",
    name: "PublyApp",
    repoPath: "/tmp/does-not-need-to-exist",
    defaultBaseBranch: "develop",
    checks,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  });
  const ticketId = new ObjectId();
  await database.collection("tickets").insertOne({
    _id: ticketId,
    boardId: boardId.toString(),
    seq: 1,
    title: "t",
    status: "approved",
    runner: "claude",
    activeRunId: null,
    dependsOn: [],
    activity: [],
    spec: {
      intent: "do the thing",
      scope: "",
      nonGoals: "",
      acceptance: ["it works"],
      links: [],
      risk: "low",
      approvedAt: "2026-08-07T00:00:00.000Z",
      approvedBy: "radan",
    },
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  });
  return ticketId.toString();
}

describe("dispatchRun acceptance-check preflight", () => {
  beforeEach(async () => {
    const database = await db();
    await database.collection("runs").deleteMany({});
  });

  it("refuses to dispatch an execute run when the board has no checks", async () => {
    const ticketId = await seed([]);
    await expect(dispatchRun(ticketId, "execute")).rejects.toMatchObject({
      code: "no_acceptance_checks",
    });
  });

  it("leaves the ticket unclaimed when the preflight refuses", async () => {
    const ticketId = await seed([]);
    await dispatchRun(ticketId, "execute").catch(() => undefined);
    const database = await db();
    const ticket = await database
      .collection("tickets")
      .findOne({ _id: new ObjectId(ticketId) });
    expect(ticket?.activeRunId).toBeNull();
    expect(ticket?.status).toBe("approved");
    expect(await database.collection("runs").countDocuments()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/server/dispatch.preflight.smoke.test.ts`

Expected: FAIL. The first test fails because `dispatchRun` resolves (or throws a different code) instead of rejecting with `no_acceptance_checks`.

- [ ] **Step 3: Write the minimal implementation**

In `src/server/supervisor.server.ts`, immediately after `const board = BoardSchema.parse(rawBoard);`:

```ts
  // A board with no acceptance checks degrades verification to "a commit
  // appeared" (verdictFrom's no-checks branch), which is the exact claim this
  // app exists to be better than. Refuse before anything is claimed or spawned.
  // spec_draft is exempt: it is read-only and produces no commit to verify.
  if (phase !== "spec_draft" && board.checks.length === 0) {
    throw new ServerResultError(
      "no_acceptance_checks",
      `board "${board.slug}" has no acceptance checks — add at least one before dispatching`,
    );
  }
```

The placement matters: it is **after** the board is loaded and **before** the ticket CAS claim, so a refused dispatch leaves the ticket untouched.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test src/server/dispatch.preflight.smoke.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Prove the test is revert-sensitive**

Comment out the `if (phase !== "spec_draft" && ...)` block. Re-run.
Expected: the test named `"refuses to dispatch an execute run when the board has no checks"` fails on its **own** `rejects.toMatchObject` assertion.
Restore the block.

- [ ] **Step 6: Full suite + typecheck**

Run: `bun run typecheck && bun run test`
Expected: typecheck exits 0. Test count rises by 2.

- [ ] **Step 7: Commit**

```bash
git add src/server/supervisor.server.ts src/server/dispatch.preflight.smoke.test.ts
git commit -m "feat(dispatch): refuse a board with no acceptance checks

verdictFrom treats an empty checks array as 'a commit alone passes', so on
a checkless board the verification contract degrades to exactly the claim
this app exists to improve on. Refuse before the ticket is claimed rather
than run an agent whose work nothing will check.

spec_draft is exempt: read-only, no commit, never verified."
```

---

## Task 2: Structured spec draft, applied to its ticket

**Files:**
- Modify: `src/domain/schemas.ts` (add `DraftedSpecSchema` after `SpecSchema`, currently line 72)
- Modify: `src/runners/types.ts` (add `specPath?: string` to `RunnerBrief`)
- Modify: `src/runners/brief.ts` (the `spec_draft` branch)
- Modify: `src/server/supervisor.server.ts` (the `spec_draft` completion branch at line 651; and where the brief is built for dispatch, line 2050)
- Create: `src/server/draftedSpec.server.ts`
- Test: `src/server/draftedSpec.test.ts` (create), `src/server/specApply.smoke.test.ts` (create)

**Interfaces:**
- Consumes: `SpecSchema`, `TicketSchema` from `src/domain/schemas`; `runPaths(board, runId, phase)` from `supervisor.server.ts`.
- Produces:
  - `DraftedSpecSchema` — Zod schema; `type DraftedSpec = { intent: string; scope: string; nonGoals: string; acceptance: string[]; links: string[]; risk: "low" | "medium" | "high" }`
  - `readDraftedSpec(runDir: string): Promise<DraftedSpec | null>` — `null` on missing or invalid.

**Why:** A `spec_draft` run today emits only prose (`parseSummary(stdout)`) and its completion branch carries the comment *"ticket stays inbox"*. A real draft was produced on 2026-08-06 and had nowhere to go. Give the runner a structured artifact and write it back.

- [ ] **Step 1: Add the schema**

In `src/domain/schemas.ts`, after `export type Spec = z.infer<typeof SpecSchema>;`:

```ts
// The subset of a Spec a spec_draft runner is allowed to author. Approval
// fields are absent by construction, so a runner can never mark its own draft
// approved — that is the owner's gate and the only thing separating a draft
// from a dispatchable spec.
export const DraftedSpecSchema = z
  .object({
    intent: z.string().min(1),
    scope: z.string().default(""),
    nonGoals: z.string().default(""),
    acceptance: z.array(z.string().min(1)).default([]),
    links: z.array(z.string()).default([]),
    risk: Risk.default("low"),
  })
  .strict();
export type DraftedSpec = z.infer<typeof DraftedSpecSchema>;
```

- [ ] **Step 2: Write the failing reader test**

Create `src/server/draftedSpec.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDraftedSpec } from "./draftedSpec.server";

describe("readDraftedSpec", () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "t4d-ds-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("returns null when spec.json is absent", async () => {
    expect(await readDraftedSpec(runDir)).toBeNull();
  });

  it("returns null when spec.json is not valid JSON", async () => {
    await writeFile(join(runDir, "spec.json"), "{not json");
    expect(await readDraftedSpec(runDir)).toBeNull();
  });

  it("returns null when intent is missing", async () => {
    await writeFile(
      join(runDir, "spec.json"),
      JSON.stringify({ acceptance: ["a"] }),
    );
    expect(await readDraftedSpec(runDir)).toBeNull();
  });

  it("returns null when the runner smuggles an approval field", async () => {
    await writeFile(
      join(runDir, "spec.json"),
      JSON.stringify({
        intent: "do it",
        approvedAt: "2026-08-07T00:00:00.000Z",
        approvedBy: "radan",
      }),
    );
    expect(await readDraftedSpec(runDir)).toBeNull();
  });

  it("parses a valid draft and applies defaults", async () => {
    await writeFile(
      join(runDir, "spec.json"),
      JSON.stringify({ intent: "add confetti", acceptance: ["fires once"] }),
    );
    expect(await readDraftedSpec(runDir)).toEqual({
      intent: "add confetti",
      scope: "",
      nonGoals: "",
      acceptance: ["fires once"],
      links: [],
      risk: "low",
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run test src/server/draftedSpec.test.ts`
Expected: FAIL — `Cannot find module './draftedSpec.server'`.

- [ ] **Step 4: Write the reader**

Create `src/server/draftedSpec.server.ts`:

```ts
import { readFile } from "node:fs/promises";
import { DraftedSpecSchema, type DraftedSpec } from "../domain/schemas";

// Read + validate <runDir>/spec.json. Fail-closed like readOutcome: a missing,
// unreadable, unparseable or invalid file yields null, and the caller leaves
// the ticket alone. A partially-applied spec is worse than none — it looks
// approval-ready while missing the acceptance criteria the contract rests on.
export async function readDraftedSpec(
  runDir: string,
): Promise<DraftedSpec | null> {
  let raw: string;
  try {
    raw = await readFile(`${runDir}/spec.json`, "utf8");
  } catch {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = DraftedSpecSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun run test src/server/draftedSpec.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit the reader**

```bash
git add src/domain/schemas.ts src/server/draftedSpec.server.ts src/server/draftedSpec.test.ts
git commit -m "feat(spec): add a validated spec.json artifact for spec_draft runs

DraftedSpecSchema is .strict() and omits approvedAt/approvedBy, so a runner
cannot mark its own draft approved. The reader is fail-closed: anything
missing or malformed yields null and the caller leaves the ticket alone."
```

- [ ] **Step 7: Teach the runner to write it**

In `src/runners/types.ts`, add to `RunnerBrief`:

```ts
  // Absolute path a spec_draft runner must write its structured spec to.
  specPath?: string;
```

In `src/runners/brief.ts`, replace the `spec_draft` branch's final line with two lines:

```ts
  if (brief.phase === "spec_draft") {
    return [
      `You are drafting the executable spec for ticket #${ticket.seq}: ${ticket.title}.`,
      `Repo: ${board.repoPath} (base branch: ${board.defaultBaseBranch}).`,
      `Intent: ${ticket.spec.intent}`,
      "Investigate the repo READ-ONLY and produce: a concrete plan, affected files, verification commands, and risks. Do not modify any file.",
      `Acceptance criteria:\n${acceptance || "none provided"}`,
      `When you finish, write this JSON to ${brief.specPath ?? "<runDir>/spec.json"} and nothing else to it:`,
      `{"intent":"<one sentence>","scope":"<files/areas to touch>","nonGoals":"<what must NOT change>","acceptance":["<checkable criterion>"],"links":["<url>"],"risk":"low|medium|high"}`,
      "Every acceptance criterion must be checkable by a command or an observation, not a feeling. Do not include approval fields; approval is the owner's.",
      "End your output with a section titled SUMMARY containing at most 10 lines.",
    ].join("\n\n");
  }
```

In `src/server/supervisor.server.ts` where the dispatch brief is built (line 2050 area), pass `specPath` for the `spec_draft` phase, alongside the existing `outcomePath`:

```ts
    specPath: phase === "spec_draft" ? `${paths.runDir}/spec.json` : undefined,
```

- [ ] **Step 8: Write the failing apply test**

Create `src/server/specApply.smoke.test.ts`. It calls the exported apply function directly — it does not spawn a runner.

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it } from "vitest";

const TEST_DB = `tosin4dev-test-spec-apply-${process.pid}-${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;

const { db } = await import("./db");
const { applyDraftedSpec } = await import("./supervisor.server");

let runDir: string;
let ticketId: string;

async function seedTicket(status: string): Promise<string> {
  const database = await db();
  await database.collection("tickets").deleteMany({});
  const id = new ObjectId();
  await database.collection("tickets").insertOne({
    _id: id,
    boardId: new ObjectId().toString(),
    seq: 1,
    title: "confetti",
    status,
    runner: "claude",
    activeRunId: null,
    dependsOn: [],
    activity: [],
    spec: {
      intent: "confetti on landing",
      scope: "",
      nonGoals: "",
      acceptance: [],
      links: [],
      risk: "low",
      approvedAt: null,
      approvedBy: null,
    },
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  });
  return id.toString();
}

describe("applyDraftedSpec", () => {
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "t4d-sa-"));
    ticketId = await seedTicket("inbox");
  });

  it("writes the draft and moves the ticket to spec_review", async () => {
    await writeFile(
      join(runDir, "spec.json"),
      JSON.stringify({
        intent: "confetti on first visit",
        scope: "apps/front",
        acceptance: ["fires once per browser"],
        risk: "medium",
      }),
    );
    await applyDraftedSpec(ticketId, runDir, "2026-08-07T01:00:00.000Z");
    const database = await db();
    const t = await database
      .collection("tickets")
      .findOne({ _id: new ObjectId(ticketId) });
    expect(t?.status).toBe("spec_review");
    expect(t?.spec.intent).toBe("confetti on first visit");
    expect(t?.spec.acceptance).toEqual(["fires once per browser"]);
    expect(t?.spec.risk).toBe("medium");
    // The runner may not approve its own draft.
    expect(t?.spec.approvedAt).toBeNull();
    expect(t?.spec.approvedBy).toBeNull();
  });

  it("leaves the ticket in inbox when the draft is invalid", async () => {
    await writeFile(join(runDir, "spec.json"), JSON.stringify({ scope: "x" }));
    await applyDraftedSpec(ticketId, runDir, "2026-08-07T01:00:00.000Z");
    const database = await db();
    const t = await database
      .collection("tickets")
      .findOne({ _id: new ObjectId(ticketId) });
    expect(t?.status).toBe("inbox");
    expect(t?.spec.intent).toBe("confetti on landing");
  });

  it("refuses to clobber a ticket that has left inbox", async () => {
    const moved = await seedTicket("spec_review");
    await writeFile(
      join(runDir, "spec.json"),
      JSON.stringify({ intent: "late draft" }),
    );
    await applyDraftedSpec(moved, runDir, "2026-08-07T01:00:00.000Z");
    const database = await db();
    const t = await database
      .collection("tickets")
      .findOne({ _id: new ObjectId(moved) });
    expect(t?.spec.intent).toBe("confetti on landing");
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

Run: `bun run test src/server/specApply.smoke.test.ts`
Expected: FAIL — `applyDraftedSpec` is not exported.

- [ ] **Step 10: Implement `applyDraftedSpec` and call it**

In `src/server/supervisor.server.ts`, add near `transitionTicketSucceeded` (around line 468):

```ts
// Write a completed spec_draft's structured output into its ticket and move it
// to spec_review for the owner to approve.
//
// The `status: "inbox"` filter IS the guard: inbox is the only status carrying
// a submit_spec edge, so a draft that completes after the owner has already
// moved the ticket on is refused by the state machine's own rule rather than
// clobbering work. A null return from readDraftedSpec is a no-op for the same
// reason a partial spec is refused — it would look approval-ready while
// missing the acceptance criteria the whole contract rests on.
export async function applyDraftedSpec(
  ticketId: string,
  runDir: string,
  at: string,
): Promise<void> {
  const draft = await readDraftedSpec(runDir);
  if (!draft) return;
  const database = await db();
  await database.collection<TicketDoc>("tickets").updateOne(
    { _id: new ObjectId(ticketId), status: "inbox" },
    {
      $set: {
        status: transition("inbox", "submit_spec"),
        "spec.intent": draft.intent,
        "spec.scope": draft.scope,
        "spec.nonGoals": draft.nonGoals,
        "spec.acceptance": draft.acceptance,
        "spec.links": draft.links,
        "spec.risk": draft.risk,
        updatedAt: at,
      },
      $push: pushActivity("spec", "drafted spec applied", at),
    },
  );
}
```

Add the import at the top of the file:

```ts
import { readDraftedSpec } from "./draftedSpec.server";
```

Then in the `spec_draft` completion branch (line 651), after the run's `updateOne` and only when `succeeded`:

```ts
  // spec_draft: read-only, no verification. A successful draft writes itself
  // into the ticket; a failed one leaves it alone.
  if (phase === "spec_draft") {
    // ... existing run updateOne ...
    if (succeeded) {
      await applyDraftedSpec(ticketId, runDir, at);
    }
    return "completed";
  }
```

Keep the existing `return` shape of that branch exactly as it is; only insert the two new lines.

- [ ] **Step 11: Run it to verify it passes**

Run: `bun run test src/server/specApply.smoke.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 12: Prove each test is revert-sensitive**

- Remove `if (!draft) return;` → `"leaves the ticket in inbox when the draft is invalid"` fails on its own `expect(t?.status).toBe("inbox")`.
- Change the filter `status: "inbox"` to `{}` → `"refuses to clobber a ticket that has left inbox"` fails on its own `expect(t?.spec.intent)`.
- Remove the `applyDraftedSpec` call from the `spec_draft` branch → no test in this file fails (they call it directly), so **also** confirm by hand that the call exists. Note this gap in your report rather than adding a spawn-level test.

Restore everything.

- [ ] **Step 13: Full suite + typecheck, then commit**

Run: `bun run typecheck && bun run test`

```bash
git add src/runners/types.ts src/runners/brief.ts src/server/supervisor.server.ts src/server/specApply.smoke.test.ts
git commit -m "feat(spec): apply a completed spec draft to its ticket

A spec_draft run produced a good ten-point draft on 2026-08-06 and it went
nowhere: the ticket stayed inbox with acceptance []. The runner now writes a
validated spec.json and a successful draft writes itself into the ticket,
moving inbox -> spec_review for the owner to approve.

The status: inbox filter is the guard. inbox is the only status with a
submit_spec edge, so a late draft is refused by the state machine's own rule
instead of clobbering a spec the owner has since edited."
```

---

## Task 3: Pure fix-loop decision module

**Files:**
- Create: `src/domain/fix-loop.ts`
- Test: `src/domain/fix-loop.test.ts` (create)

**Interfaces:**
- Consumes: `Evidence` from `src/domain/schemas` (for the `checks` element type).
- Produces:
  - `MAX_FIX_ATTEMPTS: 2`
  - `FIX_SIGNATURE_TAIL_BYTES: 2048`
  - `fixSignature(checks: { key: string; exitCode: number; output: string }[]): string`
  - `type FixDecision = { retry: true } | { retry: false; reason: "budget_exhausted" | "repeated_failure" | "not_retryable" }`
  - `decideFix(input: { failureKind: string | null; attempts: number; signature: string; lastSignature: string | null }): FixDecision`

**Why:** Pure so it can be unit-tested without Mongo, git, or a spawned process. This follows the `src/domain/check-draft.ts` precedent — logic that route and supervisor files cannot exercise under vitest gets extracted rather than tested through a mock.

- [ ] **Step 1: Write the failing test**

Create `src/domain/fix-loop.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  decideFix,
  fixSignature,
  FIX_SIGNATURE_TAIL_BYTES,
  MAX_FIX_ATTEMPTS,
} from "./fix-loop";

const failing = [{ key: "lint", exitCode: 1, output: "error: unused var x" }];

describe("fixSignature", () => {
  it("is stable for identical failures", () => {
    expect(fixSignature(failing)).toBe(fixSignature([...failing]));
  });

  it("differs when a different check fails", () => {
    expect(fixSignature(failing)).not.toBe(
      fixSignature([{ key: "format", exitCode: 1, output: "error: unused var x" }]),
    );
  });

  it("differs when the exit code differs", () => {
    expect(fixSignature(failing)).not.toBe(
      fixSignature([{ key: "lint", exitCode: 2, output: "error: unused var x" }]),
    );
  });

  it("ignores a varying prefix beyond the tail window", () => {
    const tail = "the actual error";
    const a = "A".repeat(FIX_SIGNATURE_TAIL_BYTES) + tail;
    const b = "B".repeat(FIX_SIGNATURE_TAIL_BYTES) + tail;
    expect(fixSignature([{ key: "lint", exitCode: 1, output: a }])).toBe(
      fixSignature([{ key: "lint", exitCode: 1, output: b }]),
    );
  });

  it("is order-independent across checks", () => {
    const one = { key: "lint", exitCode: 1, output: "a" };
    const two = { key: "format", exitCode: 1, output: "b" };
    expect(fixSignature([one, two])).toBe(fixSignature([two, one]));
  });
});

describe("decideFix", () => {
  const base = {
    failureKind: "verification_failed",
    attempts: 0,
    signature: "sig-a",
    lastSignature: null as string | null,
  };

  it("retries a first verification failure", () => {
    expect(decideFix(base)).toEqual({ retry: true });
  });

  it("does not retry no_commit", () => {
    expect(decideFix({ ...base, failureKind: "no_commit" })).toEqual({
      retry: false,
      reason: "not_retryable",
    });
  });

  it("does not retry a runner_exit failure", () => {
    expect(decideFix({ ...base, failureKind: "runner_exit" })).toEqual({
      retry: false,
      reason: "not_retryable",
    });
  });

  it("stops once the budget is exhausted", () => {
    expect(decideFix({ ...base, attempts: MAX_FIX_ATTEMPTS })).toEqual({
      retry: false,
      reason: "budget_exhausted",
    });
  });

  it("stops on a repeated signature even with budget left", () => {
    expect(
      decideFix({ ...base, attempts: 1, signature: "sig-a", lastSignature: "sig-a" }),
    ).toEqual({ retry: false, reason: "repeated_failure" });
  });

  it("retries when the signature changed and budget remains", () => {
    expect(
      decideFix({ ...base, attempts: 1, signature: "sig-b", lastSignature: "sig-a" }),
    ).toEqual({ retry: true });
  });

  it("prefers budget_exhausted over repeated_failure when both hold", () => {
    expect(
      decideFix({
        ...base,
        attempts: MAX_FIX_ATTEMPTS,
        signature: "sig-a",
        lastSignature: "sig-a",
      }),
    ).toEqual({ retry: false, reason: "budget_exhausted" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test src/domain/fix-loop.test.ts`
Expected: FAIL — `Cannot find module './fix-loop'`.

- [ ] **Step 3: Write the module**

Create `src/domain/fix-loop.ts`:

```ts
import { createHash } from "node:crypto";

// Two attempts, not more. Every attempt costs tokens the owner pays for, and an
// agent that has failed the same checks twice is not one prompt from success.
export const MAX_FIX_ATTEMPTS = 2;

// Only the tail of a check's output enters the signature. A varying prefix
// (timings, absolute paths, progress spinners) would otherwise make two
// identical failures hash differently and defeat the repeat guard entirely.
export const FIX_SIGNATURE_TAIL_BYTES = 2048;

export type FixDecision =
  | { retry: true }
  | {
      retry: false;
      reason: "budget_exhausted" | "repeated_failure" | "not_retryable";
    };

// A stable fingerprint of "which checks failed and how". Sorted by key so two
// runs that fail the same checks in a different order hash the same.
export function fixSignature(
  checks: { key: string; exitCode: number; output: string }[],
): string {
  const hash = createHash("sha256");
  for (const check of [...checks].sort((a, b) => a.key.localeCompare(b.key))) {
    hash.update(check.key);
    hash.update(String(check.exitCode));
    hash.update(check.output.slice(-FIX_SIGNATURE_TAIL_BYTES));
  }
  return hash.digest("hex");
}

// Should a failed verification be handed back to the agent?
//
// Order matters. Budget is checked before the repeat guard so that exhausting
// the budget on a repeated failure reports the budget — the owner-facing
// message differs, and "you spent everything" is the more actionable of the two.
export function decideFix(input: {
  failureKind: string | null;
  attempts: number;
  signature: string;
  lastSignature: string | null;
}): FixDecision {
  // Only a failed acceptance check is worth another prompt. An agent that
  // committed nothing, or whose process exited nonzero, has a different problem
  // and re-prompting it burns twenty minutes to arrive in the same place.
  if (input.failureKind !== "verification_failed") {
    return { retry: false, reason: "not_retryable" };
  }
  if (input.attempts >= MAX_FIX_ATTEMPTS) {
    return { retry: false, reason: "budget_exhausted" };
  }
  if (input.lastSignature !== null && input.lastSignature === input.signature) {
    return { retry: false, reason: "repeated_failure" };
  }
  return { retry: true };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run test src/domain/fix-loop.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Prove revert-sensitivity**

- Change `check.output.slice(-FIX_SIGNATURE_TAIL_BYTES)` to `check.output` → `"ignores a varying prefix beyond the tail window"` fails on its own `expect`.
- Remove the `.sort(...)` → `"is order-independent across checks"` fails on its own `expect`.
- Swap the budget and repeat checks → `"prefers budget_exhausted over repeated_failure when both hold"` fails on its own `expect`.

Restore.

- [ ] **Step 6: Commit**

```bash
git add src/domain/fix-loop.ts src/domain/fix-loop.test.ts
git commit -m "feat(fix-loop): pure retry decision and failure signature

Extracted as a pure module so every guard is unit-testable without Mongo,
git or a spawned runner, following the check-draft.ts precedent.

The signature hashes only the last 2KB of each failing check's output: a
varying prefix (timings, paths) would otherwise make two identical failures
look different and defeat the repeat guard."
```

---

## Task 4: Wire the fix loop into verification

**Files:**
- Modify: `src/domain/schemas.ts` (`RunSchema` — add `fixAttempts`, `lastFixSignature`)
- Modify: `src/server/supervisor.server.ts` (the verification failure branch, currently lines 831–841)
- Test: `src/server/fixLoop.smoke.test.ts` (create)

**Interfaces:**
- Consumes: `decideFix`, `fixSignature` from `src/domain/fix-loop`; `continueExecution(runId: string)` — existing export at line 1630, the mechanism that sends a new turn to an already-leased session.
- Produces: `deliverFixFeedback(runId: string, checks, at: string): Promise<FixDecision>` exported from `supervisor.server.ts` for tests.

**Why:** Today a failed check ends the run. The failing output goes back to the agent instead, under the four guards.

**Read before starting:** `continueExecution` at line 1630 and `resumeRun` at line 1052. The fix loop reuses their turn + lease machinery; it must not invent a second path for sending a turn.

- [ ] **Step 1: Extend the run schema**

In `src/domain/schemas.ts`, inside `RunSchema` after `failureKind`:

```ts
  // How many times failing acceptance checks have been handed back to the
  // agent on this run. Bounded by MAX_FIX_ATTEMPTS.
  fixAttempts: z.number().int().min(0).default(0),
  // Signature of the failure last delivered to the agent. A repeat means the
  // agent saw this exact failure and did not fix it; delivering it again buys
  // nothing. null until the first delivery.
  lastFixSignature: z.string().nullable().default(null),
```

- [ ] **Step 2: Write the failing test**

Create `src/server/fixLoop.smoke.test.ts`:

```ts
import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_FIX_ATTEMPTS, fixSignature } from "../domain/fix-loop";

const TEST_DB = `tosin4dev-test-fix-loop-${process.pid}-${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;

const { db } = await import("./db");
const { deliverFixFeedback } = await import("./supervisor.server");

const FAILING = [{ key: "lint", exitCode: 1, output: "error: unused var" }];

async function seedRun(over: Record<string, unknown>): Promise<string> {
  const database = await db();
  await database.collection("runs").deleteMany({});
  const id = new ObjectId();
  await database.collection("runs").insertOne({
    _id: id,
    ticketId: new ObjectId().toString(),
    boardId: new ObjectId().toString(),
    runner: "claude",
    phase: "execute",
    status: "verifying",
    workDir: "/tmp/wd",
    promptFile: "/tmp/p",
    logFile: "/tmp/l",
    stderrFile: null,
    exitCode: 0,
    summary: null,
    branch: "tosin4dev/run/x",
    baseSha: "a".repeat(40),
    verdict: null,
    failureKind: null,
    executionSessionId: "sess-1",
    executionLeaseId: null,
    executionLeaseExpiresAt: null,
    parkedBy: "question",
    awaitingQuestion: null,
    exchanges: [],
    turns: [],
    fixAttempts: 0,
    lastFixSignature: null,
    queuedAt: "2026-08-07T00:00:00.000Z",
    startedAt: "2026-08-07T00:00:00.000Z",
    ...over,
  });
  return id.toString();
}

describe("deliverFixFeedback", () => {
  beforeEach(async () => {
    const database = await db();
    await database.collection("runs").deleteMany({});
  });

  it("stops when the attempt budget is exhausted", async () => {
    const runId = await seedRun({ fixAttempts: MAX_FIX_ATTEMPTS });
    const decision = await deliverFixFeedback(runId, FAILING, "2026-08-07T01:00:00.000Z");
    expect(decision).toEqual({ retry: false, reason: "budget_exhausted" });
  });

  it("stops on a repeated signature before spending the remaining budget", async () => {
    const runId = await seedRun({
      fixAttempts: 1,
      lastFixSignature: fixSignature(FAILING),
    });
    const decision = await deliverFixFeedback(runId, FAILING, "2026-08-07T01:00:00.000Z");
    expect(decision).toEqual({ retry: false, reason: "repeated_failure" });
    const database = await db();
    const run = await database.collection("runs").findOne({ _id: new ObjectId(runId) });
    // Budget was NOT consumed by a decision that never delivered anything.
    expect(run?.fixAttempts).toBe(1);
  });

  it("does not mark feedback delivered when the run is parked awaiting input", async () => {
    const runId = await seedRun({ status: "awaiting_input" });
    const decision = await deliverFixFeedback(runId, FAILING, "2026-08-07T01:00:00.000Z");
    expect(decision).toEqual({ retry: false, reason: "suppressed" });
    const database = await db();
    const run = await database.collection("runs").findOne({ _id: new ObjectId(runId) });
    expect(run?.lastFixSignature).toBeNull();
    expect(run?.fixAttempts).toBe(0);
  });

  it("records the signature and increments the budget on a real delivery", async () => {
    const runId = await seedRun({});
    const decision = await deliverFixFeedback(runId, FAILING, "2026-08-07T01:00:00.000Z");
    expect(decision).toEqual({ retry: true });
    const database = await db();
    const run = await database.collection("runs").findOne({ _id: new ObjectId(runId) });
    expect(run?.fixAttempts).toBe(1);
    expect(run?.lastFixSignature).toBe(fixSignature(FAILING));
  });
});
```

Note the fourth reason value, `"suppressed"` — it is decided by the supervisor (which knows run status), not by the pure module. Add it to the union in `src/domain/fix-loop.ts`:

```ts
      reason: "budget_exhausted" | "repeated_failure" | "not_retryable" | "suppressed";
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run test src/server/fixLoop.smoke.test.ts`
Expected: FAIL — `deliverFixFeedback` is not exported.

- [ ] **Step 4: Implement `deliverFixFeedback`**

In `src/server/supervisor.server.ts`:

```ts
// Hand failing acceptance checks back to the agent, under four guards.
//
// Returns the decision so the caller knows whether the run continues or falls
// through to the existing failure path. Only a `retry: true` result consumes
// budget or records a signature — a decision that delivered nothing must not
// look like a delivery, or the next call will misjudge on stale state.
export async function deliverFixFeedback(
  runId: string,
  failing: { key: string; exitCode: number; output: string }[],
  at: string,
): Promise<FixDecision> {
  const database = await db();
  const runs = database.collection<RunDoc>("runs");
  const raw = await runs.findOne({ _id: new ObjectId(runId) });
  if (!raw) return { retry: false, reason: "not_retryable" };
  const run = RunSchema.parse(raw);

  // Suppressed, not sent. A parked run cannot receive a turn, and marking this
  // delivered would leave the agent waiting on advice it never got. Fail closed:
  // no budget consumed, no signature recorded, so it re-fires on resume.
  if (run.status === "awaiting_input") {
    return { retry: false, reason: "suppressed" };
  }

  const signature = fixSignature(failing);
  const decision = decideFix({
    failureKind: "verification_failed",
    attempts: run.fixAttempts,
    signature,
    lastSignature: run.lastFixSignature,
  });
  if (!decision.retry) return decision;

  // The branch tip moved while checks were running, so these failures describe a
  // commit that no longer exists. Delivering them would be a lie. Re-verify.
  const tipNow = (
    await execFileAsync("git", ["-C", run.workDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    })
  ).stdout.trim();
  if (run.branch !== null && tipNow !== (await verifiedTipFor(run))) {
    return { retry: false, reason: "suppressed" };
  }

  await runs.updateOne(
    { _id: new ObjectId(runId), fixAttempts: run.fixAttempts },
    { $set: { fixAttempts: run.fixAttempts + 1, lastFixSignature: signature, updatedAt: at } },
  );
  return decision;
}
```

**Note for the implementer:** `verifiedTipFor(run)` above is a placeholder for reading the tip recorded when verification began. The evidence row already stores `commitSha`; use that rather than adding a field — read the latest `evidence` document for this `runId` and compare `tipNow` against its `commitSha`. If no evidence row exists yet, treat the tip as stable. Replace the placeholder with that lookup and say so in your report.

Add the imports:

```ts
import { decideFix, fixSignature, type FixDecision } from "../domain/fix-loop";
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun run test src/server/fixLoop.smoke.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Wire it into the verification failure branch**

In `src/server/supervisor.server.ts`, replace the current failure tail (lines 831–841) so `deliverFixFeedback` is consulted first:

```ts
    const failing = result.checks.filter((c) => c.exitCode !== 0);
    const decision =
      result.failureKind === "verification_failed"
        ? await deliverFixFeedback(runId, failing, doneAt)
        : ({ retry: false, reason: "not_retryable" } as const);

    if (decision.retry) {
      // Back to the agent on the existing leased session. The ticket stays
      // `running` — a retry is not a new state, it is the same run continuing.
      await continueExecution(runId, formatCheckFailures(failing));
      return "completed";
    }

    await failVerifiedRun(
      database,
      runId,
      result.failureKind ?? "verification_failed",
      exitCode,
      outSummary,
      doneAt,
      turnStamp(turnId, "completed"),
    );
    await transitionTicketFailed(database, ticketId, runId, doneAt, `verification ${result.failureKind}`);
    await notifyBlocked(
      database,
      ticketId,
      // Budget exhausted and a repeated failure are different diagnoses and must
      // not read the same — one says "it kept trying", the other "it gave up
      // because nothing changed".
      `verification failed (${result.failureKind}); fix loop stopped: ${decision.reason}`,
      logFile,
      stderrFile,
    );
    return "completed";
```

Add a small formatter beside it:

```ts
// What the agent actually receives. Only failing checks, each with its command
// and the tail of its output — the whole log would bury the signal.
function formatCheckFailures(
  failing: { key: string; exitCode: number; output: string }[],
): string {
  const blocks = failing.map(
    (c) =>
      `Check "${c.key}" failed with exit code ${c.exitCode}:\n${c.output.slice(-FIX_SIGNATURE_TAIL_BYTES)}`,
  );
  return [
    "Your commit did not pass this board's acceptance checks.",
    ...blocks,
    "Fix the cause, commit again on the same branch, and do not push.",
  ].join("\n\n");
}
```

Import `FIX_SIGNATURE_TAIL_BYTES` alongside the others.

**If `continueExecution`'s signature does not accept a message argument**, do not change its signature blindly — read it, and report what shape it needs before adapting. It is the same machinery `resumeRun` uses and it is lease-guarded.

- [ ] **Step 7: Prove each guard is revert-sensitive**

Revert each in turn, confirm the *named* test fails on its *own* `expect`, restore:

- Remove the `status === "awaiting_input"` early return → `"does not mark feedback delivered when the run is parked awaiting input"`.
- Remove `if (!decision.retry) return decision;` → `"stops on a repeated signature before spending the remaining budget"`.
- Change `MAX_FIX_ATTEMPTS` to `99` → `"stops when the attempt budget is exhausted"`.
- Remove the `$set` of `lastFixSignature` → `"records the signature and increments the budget on a real delivery"`.

- [ ] **Step 8: Full suite + typecheck, then commit**

Run: `bun run typecheck && bun run test`

```bash
git add src/domain/schemas.ts src/domain/fix-loop.ts src/server/supervisor.server.ts src/server/fixLoop.smoke.test.ts
git commit -m "feat(fix-loop): hand failing checks back to the agent, bounded

Four guards, each from a documented incident in agent-orchestrator: an
attempt budget so a loop cannot burn tokens indefinitely, a head-SHA check
so failures about a superseded commit are never delivered, a dedup
signature that stops the loop when the agent has already seen this exact
failure, and sent-vs-suppressed so a parked run's feedback re-fires on
resume instead of being silently counted as delivered.

no_commit and runner_exit do not retry: an agent that committed nothing has
a different problem."
```

---

## Task 5: Push the verified branch and open a draft PR

**Files:**
- Modify: `src/domain/schemas.ts` (`RunSchema` — add `prUrl`)
- Create: `src/server/publish.server.ts`
- Test: `src/server/publish.test.ts` (create), `src/server/publish.smoke.test.ts` (create)
- Modify: `src/server/supervisor.server.ts` (dispatch preflight; the `verdict === "passed"` branch at line 808)

**Interfaces:**
- Consumes: `Board`, `Ticket`, `Evidence` from `src/domain/schemas`.
- Produces:
  - `draftPrArgs(input: { base: string; head: string; title: string; bodyFile: string }): string[]` — pure argv builder.
  - `pushBranch(workDir: string, branch: string): Promise<void>`
  - `assertPublishable(board: Board, branch: string): void`
  - `preflightPublish(repoPath: string): Promise<void>`
  - `publishRun(input: { board: Board; ticket: Ticket; workDir: string; branch: string; bodyFile: string }): Promise<{ prUrl: string }>`

**Why:** Nothing pushes today. This is the one irreversible step in the pipeline, so the guards are the substance of the task, not decoration.

- [ ] **Step 1: Add `prUrl` to the run schema**

In `src/domain/schemas.ts`, inside `RunSchema` after `lastFixSignature`:

```ts
  // Draft PR opened for this run's verified branch. null until published.
  prUrl: z.string().url().nullable().default(null),
```

- [ ] **Step 2: Write the failing pure test**

Create `src/server/publish.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertPublishable, draftPrArgs } from "./publish.server";

const BOARD = {
  slug: "publyapp",
  name: "PublyApp",
  repoPath: "/home/radan/Projects/PublyApp/publyapp",
  defaultBaseBranch: "develop",
  checks: [],
};

describe("draftPrArgs", () => {
  it("always creates a draft PR", () => {
    const args = draftPrArgs({
      base: "develop",
      head: "tosin4dev/run/abc",
      title: "#1 confetti",
      bodyFile: "/tmp/body.md",
    });
    expect(args).toEqual([
      "pr", "create",
      "--draft",
      "--base", "develop",
      "--head", "tosin4dev/run/abc",
      "--title", "#1 confetti",
      "--body-file", "/tmp/body.md",
    ]);
  });

  it("never contains a ready-for-review or merge flag", () => {
    const args = draftPrArgs({
      base: "develop", head: "h", title: "t", bodyFile: "/tmp/b",
    });
    expect(args).not.toContain("--fill");
    expect(args.join(" ")).not.toMatch(/ready|merge/);
  });
});

describe("assertPublishable", () => {
  it("refuses to publish the base branch itself", () => {
    expect(() => assertPublishable(BOARD, "develop")).toThrow(/base branch/i);
  });

  it("accepts a namespaced run branch", () => {
    expect(() => assertPublishable(BOARD, "tosin4dev/run/abc")).not.toThrow();
  });

  it("refuses an empty branch", () => {
    expect(() => assertPublishable(BOARD, "")).toThrow();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run test src/server/publish.test.ts`
Expected: FAIL — `Cannot find module './publish.server'`.

- [ ] **Step 4: Write the module**

Create `src/server/publish.server.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Board } from "../domain/schemas";
import { ServerResultError } from "./result";

const execFileAsync = promisify(execFile);

// Pure argv. `--draft` is not configurable: merging is the owner's action and
// nothing in this app may mark a PR ready for review.
export function draftPrArgs(input: {
  base: string;
  head: string;
  title: string;
  bodyFile: string;
}): string[] {
  return [
    "pr", "create",
    "--draft",
    "--base", input.base,
    "--head", input.head,
    "--title", input.title,
    "--body-file", input.bodyFile,
  ];
}

// The run branch is namespaced (tosin4dev/run/<runId>) so colliding with the
// base is already near-impossible. Assert anyway: "never touch develop
// directly" is a standing rule, and an assertion is how a rule stays true when
// the naming scheme later changes.
export function assertPublishable(board: Board, branch: string): void {
  if (branch.length === 0) {
    throw new ServerResultError("not_publishable", "run has no branch to publish");
  }
  if (branch === board.defaultBaseBranch) {
    throw new ServerResultError(
      "not_publishable",
      `refusing to push the base branch "${branch}" directly`,
    );
  }
}

// Checked at DISPATCH, not at push. Discovering a broken token after twenty
// minutes of agent work is the worst available ordering.
export async function preflightPublish(repoPath: string): Promise<void> {
  try {
    await execFileAsync("gh", ["auth", "status"], { encoding: "utf8" });
  } catch {
    throw new ServerResultError(
      "gh_unauthenticated",
      "gh is not authenticated — run `gh auth login` before dispatching",
    );
  }
  try {
    await execFileAsync("git", ["-C", repoPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
    });
  } catch {
    throw new ServerResultError(
      "no_remote",
      `repo at ${repoPath} has no "origin" remote to push to`,
    );
  }
}

// Plain push. Never --force, never --force-with-lease: a rejected push is
// information, and this branch is namespaced per run so a rejection means
// something genuinely unexpected happened.
export async function pushBranch(workDir: string, branch: string): Promise<void> {
  await execFileAsync("git", ["-C", workDir, "push", "-u", "origin", branch], {
    encoding: "utf8",
  });
}

// Reuse an existing PR for this head rather than opening a second one — the fix
// loop can reach a passing verdict on a branch that was already published.
async function existingPrUrl(workDir: string, branch: string): Promise<string | null> {
  const { stdout } = await execFileAsync(
    "gh",
    ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--limit", "1"],
    { cwd: workDir, encoding: "utf8" },
  );
  const parsed: unknown = JSON.parse(stdout || "[]");
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const url = (parsed[0] as { url?: unknown }).url;
  return typeof url === "string" ? url : null;
}

export async function publishRun(input: {
  board: Board;
  title: string;
  workDir: string;
  branch: string;
  bodyFile: string;
}): Promise<{ prUrl: string }> {
  assertPublishable(input.board, input.branch);
  await pushBranch(input.workDir, input.branch);
  const existing = await existingPrUrl(input.workDir, input.branch);
  if (existing !== null) return { prUrl: existing };
  const { stdout } = await execFileAsync(
    "gh",
    draftPrArgs({
      base: input.board.defaultBaseBranch,
      head: input.branch,
      title: input.title,
      bodyFile: input.bodyFile,
    }),
    { cwd: input.workDir, encoding: "utf8" },
  );
  return { prUrl: stdout.trim() };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun run test src/server/publish.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Write the push smoke test against a local bare repo**

Create `src/server/publish.smoke.test.ts`. This exercises `pushBranch` for real — no `gh`, no network.

```ts
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pushBranch } from "./publish.server";

const exec = promisify(execFile);

let origin: string;
let clone: string;

describe("pushBranch", () => {
  beforeEach(async () => {
    origin = await mkdtemp(join(tmpdir(), "t4d-origin-"));
    await exec("git", ["-C", origin, "init", "--bare", "-b", "develop"]);
    clone = await mkdtemp(join(tmpdir(), "t4d-clone-"));
    await exec("git", ["clone", origin, clone]);
    await exec("git", ["-C", clone, "config", "user.email", "t@t"]);
    await exec("git", ["-C", clone, "config", "user.name", "t"]);
    await exec("git", ["-C", clone, "commit", "--allow-empty", "-m", "root"]);
    await exec("git", ["-C", clone, "push", "-u", "origin", "develop"]);
    await exec("git", ["-C", clone, "checkout", "-b", "tosin4dev/run/abc"]);
    await writeFile(join(clone, "f.txt"), "x");
    await exec("git", ["-C", clone, "add", "."]);
    await exec("git", ["-C", clone, "commit", "-m", "work"]);
  });
  afterEach(async () => {
    await rm(origin, { recursive: true, force: true });
    await rm(clone, { recursive: true, force: true });
  });

  it("pushes the run branch to origin", async () => {
    await pushBranch(clone, "tosin4dev/run/abc");
    const { stdout } = await exec("git", ["-C", origin, "branch", "--list", "tosin4dev/run/abc"]);
    expect(stdout.trim()).toContain("tosin4dev/run/abc");
  });

  it("leaves the local branch intact when the push fails", async () => {
    await exec("git", ["-C", clone, "remote", "set-url", "origin", join(tmpdir(), "t4d-missing-remote")]);
    await expect(pushBranch(clone, "tosin4dev/run/abc")).rejects.toThrow();
    // The verified commit must survive a failed network call.
    const { stdout } = await exec("git", ["-C", clone, "branch", "--list", "tosin4dev/run/abc"]);
    expect(stdout.trim()).toContain("tosin4dev/run/abc");
    const { stdout: log } = await exec("git", ["-C", clone, "log", "-1", "--format=%s"]);
    expect(log.trim()).toBe("work");
  });
});
```

- [ ] **Step 7: Run it to verify it passes**

Run: `bun run test src/server/publish.smoke.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 8: Add the dispatch preflight**

In `src/server/supervisor.server.ts`, directly below the Task 1 checks guard in `dispatchRun`:

```ts
  // Publishing is the last step of an execute run, so its prerequisites are
  // checked first. A broken token discovered after twenty minutes of agent work
  // is the worst available ordering.
  if (phase === "execute") {
    await preflightPublish(board.repoPath);
  }
```

Import `preflightPublish` and `publishRun` from `./publish.server`.

- [ ] **Step 9: Wire publishing into the passed branch**

In the `result.verdict === "passed"` branch (line 808), after the run's `updateOne` and **before** `transitionTicketSucceeded`:

```ts
      // The PR body carries the evidence — checks run, exit codes, commit sha —
      // so the verification contract is visible to anyone reading the PR rather
      // than living only in MongoDB.
      const bodyFile = `${runDir}/pr-body.md`;
      await writeFile(bodyFile, prBody(ticket, evidence, outSummary), "utf8");
      try {
        const { prUrl } = await publishRun({
          board,
          title: `#${ticket.seq} ${ticket.title}`,
          workDir: run?.workDir ?? board.repoPath,
          branch: run?.branch ?? "",
          bodyFile,
        });
        await runs.updateOne({ _id: new ObjectId(runId) }, { $set: { prUrl } });
        await transitionTicketSucceeded(database, ticketId, runId, doneAt);
        await notifyReviewReady(database, ticketId, `${outSummary ?? ""}\n${prUrl}`);
      } catch (error) {
        // The verified commit exists only on a local branch, and the cleanup
        // path calls `git branch -D`. Do NOT clean up here: destroying verified
        // work because a network call failed is the worst outcome available.
        await transitionTicketFailed(
          database, ticketId, runId, doneAt, "publish failed",
        );
        await notifyBlocked(
          database,
          ticketId,
          `verified but not published: ${error instanceof Error ? error.message : "unknown"}. ` +
            `Push by hand: git -C ${run?.workDir} push -u origin ${run?.branch}`,
          logFile,
          stderrFile,
        );
      }
      return "completed";
```

Write `prBody` beside `formatCheckFailures`:

```ts
// Assembled from what already exists: the locked spec, the run summary, and the
// evidence row. No new state.
function prBody(ticket: Ticket, evidence: Evidence, summary: string | null): string {
  const checks = evidence.checks
    .map((c) => `- \`${c.key}\` — exit ${c.exitCode}`)
    .join("\n");
  return [
    `### Intent\n${ticket.spec.intent}`,
    ticket.spec.acceptance.length
      ? `### Acceptance\n${ticket.spec.acceptance.map((a) => `- ${a}`).join("\n")}`
      : null,
    summary ? `### Summary\n${summary}` : null,
    `### Verification\nCommit \`${evidence.commitSha}\`\n\n${checks || "_no checks recorded_"}`,
    `_Opened by Tosin4dev. Draft — merging is the owner's action._`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
```

Ensure `writeFile` is imported from `node:fs/promises` in this file (it may already be).

- [ ] **Step 10: Prove revert-sensitivity**

- Change `--draft` to `--fill` in `draftPrArgs` → `"always creates a draft PR"` fails on its own `expect`.
- Remove the `branch === board.defaultBaseBranch` check → `"refuses to publish the base branch itself"` fails on its own `expect`.
- Add a `git branch -D` before the rejection in the failure path of the smoke test's second case → `"leaves the local branch intact when the push fails"` fails on its own `expect`. Restore immediately; this is the test protecting real work.

- [ ] **Step 11: Full suite + typecheck**

Run: `bun run typecheck && bun run test`
Expected: typecheck exits 0. No new failures beyond the known #19/#20 flakes.

- [ ] **Step 12: Commit**

```bash
git add src/domain/schemas.ts src/server/publish.server.ts src/server/publish.test.ts src/server/publish.smoke.test.ts src/server/supervisor.server.ts
git commit -m "feat(publish): push the verified branch and open a draft PR

Guards on the one irreversible step: gh auth and the origin remote are
checked at dispatch rather than after twenty minutes of agent work; the
base branch can never be pushed directly; the push is plain, never forced;
and PR creation reuses an existing PR for the head so the fix loop cannot
open a second one.

The failure path matters more than the happy one. A failed push leaves the
worktree and branch intact and tells the owner how to push by hand -
destroying a verified commit because a network call failed is the worst
outcome available."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 1. Empty `checks` refuses to dispatch | Task 1 |
| `verdictFrom` unchanged, no-checks branch stays reachable | Task 1 (asserted by the untouched `verify.test.ts`) |
| 2. PublyApp's checks (`pnpm lint`, `pnpm format`) | Configuration — see Manual Step below |
| 3. Apply a drafted spec | Task 2 |
| 4. Fix loop + four guards | Tasks 3 and 4 |
| 5. Push + draft PR + guards | Task 5 |
| Preflight at dispatch | Task 5, Step 8 |
| Failure path preserves worktree and branch | Task 5, Steps 6 and 9 |
| PR body carries the evidence | Task 5, Step 9 |

**Manual step, not a code task.** After Task 1 lands, the `publyapp` board must be given its checks through the board UI, or `execute` dispatch will refuse:

```
key: lint    label: lint    command: ["pnpm", "lint"]     timeoutMs: 300000
key: format  label: format  command: ["pnpm", "format"]   timeoutMs: 120000
```

Both run with `cwd` set to the run's worktree.

**Known gaps, stated rather than hidden:**

- Task 2, Step 12 records that no automated test pins the *call* to `applyDraftedSpec` from the `spec_draft` completion branch — only the function itself is tested. Reaching that branch requires spawning a runner. The implementer must verify the call by inspection and say so.
- Task 4, Step 4 leaves `verifiedTipFor` as a named placeholder with explicit instructions to replace it with an `evidence.commitSha` lookup. This is the one deliberate placeholder in the plan; it exists because the correct source of the pre-check tip is a judgement the implementer should make with the evidence collection in front of them, and guessing it here would be worse than naming it.
- `continueExecution`'s current signature is not verified to accept a message argument. Task 4, Step 6 instructs the implementer to read it first and report rather than change it blindly.

---

## Execution Handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.
