# Consultation Chat & Typed Input Exchanges — Implementation Plan

> **For agentic workers:** implement task-by-task, TDD, checkbox steps. Source of
> truth: `docs/superpowers/specs/2026-07-23-consultation-and-input-exchange-design.md`.

**Goal:** Give a human answering a parked `needs_input` run a real Q&A history
and a bounded, read-only second AI to consult — without giving that AI any write
path to the run.

**Architecture:** Three layers. Layer 0 fixes two output-fidelity defects that
everything downstream inherits. Layer 1 adds a typed `InputExchange` history to
the run. Layer 2 adds a consultation chat seeded from a budgeted, redacted
`RunContext` package. The human gate (`provideInput` → `resumeRun`) is unchanged.

**Tech:** Bun, TanStack Start (React 19, `createServerFn`), MongoDB standalone
(**no multi-document transactions**) + Zod at boundaries, react-query-kit,
Tailwind 4, Vitest.

**Repo conventions you must follow:**
- Server fns: `createServerFn({method}).validator(passthrough).handler(({data}) => boundary(Schema, data, coreFn))`. Cores live in `*.server.ts`.
- DTOs are built by **explicit field pick**, never `{...doc}` spread, into a `.strict()` schema.
- Serialization uses CAS claims: `updateOne({_id, status:"X"}, {$set:{status:"Y"}})` then `matchedCount === 0 → conflict`.
- Fail-closed: missing/invalid/errored → failure, never false success. **Exception, deliberate:** the handoff brief is fail-*open* (see Task 3).
- **Legacy documents have no key at all for fields added later.** `RunSchema.parse` runs only in tests — production reads go straight from `find`/`findOne` to `toDTO`, so domain-schema defaults never touch stored data. Default every new DTO field at the **explicit pick** (`doc.field ?? <default>`), and test with a document whose key is genuinely absent, never one that sets it to `null`/`[]`.
- **A test whose fixture is smaller than the limit it exercises tests nothing.** Budget/truncation logic needs inputs larger than the budget.
- Run `bun` via `export PATH="$HOME/.bun/bin:$PATH"`.
- **Parallel test runs are noisy** on standalone Mongo (concurrent smoke suites contend). Any failure must be re-checked with `bunx vitest run --no-file-parallelism` before you believe it.

---

## Task 0: Baseline

- [ ] **Step 1:** confirm branch and green baseline.

```bash
export PATH="$HOME/.bun/bin:$PATH"
git branch --show-current   # expect: feat/v5-consultation-chat
bun run test && bun run typecheck && echo BASELINE_OK
```

No commit.

---

# LAYER 0 — Output fidelity

## Task 1: `drainStream` keeps a head window

**Why this is first:** `parseSessionId` runs on the buffer `drainStream` returns
(`supervisor.server.ts:528`). Codex emits `{"type":"thread.started","thread_id":"…"}`
as its **first** line. Today the buffer keeps only the **last** 512 000 chars, so
a run with >512 KB of stdout loses its `executionSessionId` — and `resumeRun`
hard-refuses a run with no captured session (`supervisor.server.ts:719-724`).
The same function backs chat turns (`chat.server.ts:233-234`), where codex
`parseTurn` also needs that first line, so one fix closes both.

**Files:**
- Modify: `src/server/supervisor.server.ts` (const near line 56; `drainStream` at 243-260)
- Test: `src/server/drainStream.test.ts` (create)

- [ ] **Step 1 (RED): write the failing tests.**

Create `src/server/drainStream.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainStream } from "./supervisor.server";
import { parseSessionId } from "./outcome.server";

async function drain(chunks: string[]): Promise<{ out: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "drain-"));
  const file = join(dir, "out.log");
  const stream = Readable.from(chunks.map((c) => Buffer.from(c, "utf8")));
  const out = await drainStream(stream, file, true);
  return { out, file };
}

describe("drainStream", () => {
  it("returns short output unchanged and with no marker", async () => {
    const { out } = await drain(["hello\n", "world\n"]);
    expect(out).toBe("hello\nworld\n");
    expect(out).not.toContain("truncated");
  });

  it("writes every byte to the log file even when the buffer truncates", async () => {
    const big = "x".repeat(700_000);
    const { file } = await drain(["first\n", big, "\nlast\n"]);
    const onDisk = await readFile(file, "utf8");
    expect(onDisk.length).toBe("first\n".length + big.length + "\nlast\n".length);
  });

  it("keeps BOTH the head and the tail when output exceeds the cap", async () => {
    const { out } = await drain(["HEADLINE\n", "x".repeat(700_000), "\nTAILLINE\n"]);
    expect(out).toContain("HEADLINE");
    expect(out).toContain("TAILLINE");
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThanOrEqual(512_000 + 64);
  });

  it("isolates the truncation marker on its own line", async () => {
    const { out } = await drain(["HEADLINE\n", "x".repeat(700_000), "\nTAILLINE\n"]);
    const markerLine = out.split("\n").find((l) => l.includes("truncated"));
    expect(markerLine).toBeDefined();
    // The marker must not be glued to real content on either side.
    expect(markerLine?.includes("HEADLINE")).toBe(false);
    expect(markerLine?.includes("x")).toBe(false);
  });

  // The actual regression: a long codex run must still yield its session id.
  it("preserves the codex thread_id through a >512KB stream", async () => {
    const { out } = await drain([
      '{"type":"thread.started","thread_id":"019f-abc"}\n',
      `${"y".repeat(700_000)}\n`,
      '{"type":"turn.completed"}\n',
    ]);
    expect(parseSessionId("codex", out)).toBe("019f-abc");
  });
});
```

- [ ] **Step 2: run the tests to verify they fail.**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bunx vitest run src/server/drainStream.test.ts
```

Expected: the head/tail, marker, and `thread_id` tests FAIL (the first two pass —
they describe existing behaviour that must not regress).

- [ ] **Step 3: implement.**

In `src/server/supervisor.server.ts`, replace the single cap constant near line 56:

```ts
// The collected buffer feeds parseSessionId (whose marker is the FIRST line of
// provider output) and summary extraction (which cares about the END). Keep a
// head window and a tail window rather than a tail alone.
const SUMMARY_HEAD_CAP = 64_000;
const SUMMARY_TAIL_CAP = 448_000;
const TRUNCATION_MARKER = "\n…[output truncated]…\n";
```

Replace `drainStream` (243-260) with:

```ts
export async function drainStream(
  stream: Readable,
  logFile: string,
  collect: boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let head = "";
  let tail = "";
  let dropped = false;
  const absorb = (text: string): void => {
    if (head.length < SUMMARY_HEAD_CAP) {
      const room = SUMMARY_HEAD_CAP - head.length;
      head += text.slice(0, room);
      text = text.slice(room);
      if (!text) return;
    }
    tail += text;
    if (tail.length > SUMMARY_TAIL_CAP) {
      tail = tail.slice(-SUMMARY_TAIL_CAP);
      dropped = true;
    }
  };
  for await (const chunk of stream) {
    await appendFile(logFile, chunk);
    if (collect) absorb(decoder.decode(chunk, { stream: true }));
  }
  if (collect) absorb(decoder.decode());
  if (!collect) return "";
  if (!tail) return head;
  // The marker is newline-delimited on BOTH sides on purpose: without the
  // leading newline it would glue onto a partial head line, without the
  // trailing one the tail's partial first line would glue onto the marker.
  // Either would manufacture a corrupt line. As written the only damage is one
  // orphan partial line, which every line-based parser here already skips.
  return dropped ? head + TRUNCATION_MARKER + tail : head + tail;
}
```

Note the early `return "";` when `collect` is false — the old code returned the
(empty) accumulator, and the stderr drain relies on that.

- [ ] **Step 4: run the tests to verify they pass.**

```bash
bunx vitest run src/server/drainStream.test.ts   # expect: 5 passed
bunx vitest run --no-file-parallelism            # expect: full suite green
```

- [ ] **Step 5: commit.**

```bash
git add src/server/supervisor.server.ts src/server/drainStream.test.ts
git commit -m "fix(runs): keep a head window in drainStream so session ids survive long output"
```

---

## Task 2: Split stderr out of the run log

**Files:**
- Modify: `src/domain/schemas.ts` (`RunSchema`), `src/server/supervisor.server.ts` (run paths object ~163; run-doc creation ~966; log pre-write ~1020; both `drainStream` stderr call sites, ~833 and ~1037), `src/server/runs.server.ts` (`logTailCore` 97-107), `src/server/runs.ts` (`RunDTOSchema`)
- Test: `src/server/log-split.smoke.test.ts` (create)

> **Line numbers drift.** These were re-anchored after Task 1 landed (+32 lines
> in `supervisor.server.ts`). Later tasks will shift them again. Always locate
> code by **symbol** — `drainStream`, `parseSummary`, `parkTicketNeedsInput`,
> `resumeRun`, `logTailCore` — and treat any line number here as a hint, not an
> address. If a cited line does not contain what this plan says it does, grep
> for the symbol and proceed; do not edit by line number alone.

- [ ] **Step 1 (RED): write the failing smoke test.**

Create `src/server/log-split.smoke.test.ts`, modelled on the existing real-Mongo
smoke suites (copy the bootstrap from `src/server/needs-input.smoke.test.ts`).
Assert:

1. A run whose fake runner writes to both streams ends with stdout content in
   `run.logFile` and stderr content in `run.stderrFile`, with **neither file
   containing the other's content**.
2. `logTailCore({runId})` returns text containing the stdout content, the
   literal delimiter `──── stderr ────`, and the stderr content.
3. A legacy run doc with `stderrFile: null` still returns its stdout tail and
   **no** delimiter.

- [ ] **Step 2: verify it fails.**

```bash
bunx vitest run src/server/log-split.smoke.test.ts
```

- [ ] **Step 3: add the schema field.**

In `src/domain/schemas.ts`, in `RunSchema` immediately after `logFile` (line 142):

```ts
  // stdout only, since v5. stderr goes to stderrFile so JSONL framing in
  // logFile is not torn by interleaved writes. null for runs created before
  // the split.
  stderrFile: AbsolutePathString.nullable().default(null),
```

- [ ] **Step 4: write stderr to its own file.**

In `src/server/supervisor.server.ts`: wherever the run paths object is built
(near line 158, alongside `logFile: \`${runDir}/output.log\``), add
`stderrFile: \`${runDir}/stderr.log\``. Persist it on the run document at
creation (near line 928, next to `logFile: paths.logFile`) and pre-create it
next to the existing `writeFile(paths.logFile, "")` at line 982.

Change **both** stderr drains to target it:

```ts
// line ~795 (resumeRun)
stderr: drainStream(spawnedChild.stderr, run.stderrFile ?? run.logFile, false),
// line ~999 (dispatch)
stderr: drainStream(spawnedChild.stderr, paths.stderrFile, false),
```

The `?? run.logFile` fallback in `resumeRun` is required: a run created before
this change has `stderrFile: null` and must still log somewhere.

**Do not change `src/server/chat.server.ts`.** Chat sessions keep one combined
log; nothing parses that file, and widening the change costs review surface for
no gain. Chat still benefits from Task 1 automatically.

- [ ] **Step 5: surface stderr in the log viewer.**

`logTailCore` must not regress — errors usually arrive on stderr. In
`src/server/runs.server.ts` replace the return at line 106:

> **This code was wrong in the first draft of this plan and shipped two defects.**
> Splitting the budget on whether `stderrFile` is *set* halves the stdout budget
> for every run — and almost every run writes nothing to stderr, so the common
> case silently returned half the log. It also overran the stated ceiling by the
> joiner's 34 bytes. Corrected version below: read stderr **first**, and charge
> what it actually costs against the caller's budget.

```ts
export const STDERR_DELIMITER = "──── stderr ────";

export async function logTailCore(
  input: LogTailInput,
): Promise<{ text: string }> {
  const run = await (await db())
    .collection<RunDoc>("runs")
    .findOne({ _id: new ObjectId(input.runId) });
  if (!run) {
    throw new ServerResultError("not_found", `run not found: ${input.runId}`);
  }
  if (!run.stderrFile) {
    return { text: await readLogTail(run.logFile, input.bytes) };
  }
  // Read stderr FIRST. Most runs write nothing there, and the stdout budget
  // must not be halved to reserve room for a section that turns out empty.
  const joiner = `\n${STDERR_DELIMITER}\n`;
  const stderr = await readLogTail(run.stderrFile, Math.floor(input.bytes / 2));
  if (!stderr) {
    return { text: await readLogTail(run.logFile, input.bytes) };
  }
  // Charge the joiner and the stderr section against the caller's ceiling so
  // stdout + joiner + stderr <= bytes. Measure in BYTES, not chars: readLogTail
  // budgets a Buffer, and the box-drawing delimiter is multi-byte.
  const spent =
    Buffer.byteLength(stderr, "utf8") + Buffer.byteLength(joiner, "utf8");
  const stdout = await readLogTail(
    run.logFile,
    Math.max(0, input.bytes - spent),
  );
  return { text: `${stdout}${joiner}${stderr}` };
}
```

**Budget tests are mandatory here.** Every existing test uses `bytes: 20_000`
against files of a few dozen bytes, so the arithmetic is unobservable and a
mutant that deletes the split entirely passes the whole suite. Any test of this
function must use files **larger than the budget**.

- [ ] **Step 6:** add `stderrFile: AbsolutePathString.nullable()` to
`RunDTOSchema` in `src/server/runs.ts` and to the explicit pick in `toDTO`
(`runs.server.ts`). The DTO is `.strict()`, so a field added to the doc without
being added to both the schema and the pick will throw at the boundary.

- [ ] **Step 7: verify.**

```bash
bunx vitest run src/server/log-split.smoke.test.ts   # expect: PASS
bunx vitest run --no-file-parallelism && bun run typecheck
```

- [ ] **Step 8: commit.**

```bash
git add -A
git commit -m "fix(runs): write stderr to its own file, keep it visible in the log tail"
```

---

# LAYER 1 — Typed input exchanges

## Task 3: Handoff + exchange schemas

**Files:**
- Modify: `src/domain/schemas.ts`
- Test: `src/domain/exchange.schema.test.ts` (create)

- [ ] **Step 1 (RED): write the failing tests.**

```ts
import { describe, expect, it } from "vitest";
import {
  HandoffBriefSchema,
  InputExchangeSchema,
  RunOutcomeSchema,
} from "./schemas";

describe("HandoffBriefSchema", () => {
  it("defaults every field so a sparse brief still parses", () => {
    const brief = HandoffBriefSchema.parse({});
    expect(brief.workDone).toBe("");
    expect(brief.filesTouched).toEqual([]);
    expect(brief.options).toEqual([]);
  });

  it("rejects an unknown key", () => {
    expect(HandoffBriefSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
});

describe("InputExchangeSchema", () => {
  it("parses an open exchange", () => {
    const ex = InputExchangeSchema.parse({
      v: 1,
      at: "2026-07-23T10:00:00.000Z",
      question: "Which base branch?",
    });
    expect(ex.answer).toBeNull();
    expect(ex.answeredAt).toBeNull();
    expect(ex.handoff).toBeNull();
  });

  it("rejects a version other than 1", () => {
    expect(
      InputExchangeSchema.safeParse({
        v: 2,
        at: "2026-07-23T10:00:00.000Z",
        question: "q",
      }).success,
    ).toBe(false);
  });
});

describe("RunOutcomeSchema handoff (fail-OPEN)", () => {
  it("accepts needs_input with a handoff", () => {
    const o = RunOutcomeSchema.parse({
      outcome: "needs_input",
      question: "q",
      handoff: { workDone: "wired the parser", decision: "which branch" },
    });
    expect(o.handoff?.workDone).toBe("wired the parser");
  });

  it("defaults handoff to null when absent", () => {
    const o = RunOutcomeSchema.parse({ outcome: "needs_input", question: "q" });
    expect(o.handoff).toBeNull();
  });
});
```

- [ ] **Step 2: verify it fails** — `bunx vitest run src/domain/exchange.schema.test.ts`.

- [ ] **Step 3: implement.** In `src/domain/schemas.ts`, immediately before
`RunSchema` (line 134):

```ts
// A structured account of where a run stopped and what it needs decided.
// Enrichment, NOT a gate: a parked run with no handoff is still a valid
// needs_input, so nothing here may ever turn a needs_input into a failure.
export const HandoffBriefSchema = z
  .object({
    workDone: z.string().default(""),
    filesTouched: z.array(z.string()).default([]),
    commandsRun: z.array(z.string()).default([]),
    decision: z.string().default(""),
    options: z.array(z.string()).default([]),
    risk: z.string().default(""),
  })
  .strict();
export type HandoffBrief = z.infer<typeof HandoffBriefSchema>;

// One question→answer round trip on a run. `v` is the record version: this
// history is read by consultation context building and by later slices, so it
// must be able to evolve without silently reinterpreting stored rows.
// INVARIANT: the open exchange is the last element with `answer === null`, and
// at most one exists at a time.
export const InputExchangeSchema = z
  .object({
    v: z.literal(1),
    at: z.string().datetime(),
    question: z.string(),
    handoff: HandoffBriefSchema.nullable().default(null),
    answer: z.string().nullable().default(null),
    answeredAt: z.string().datetime().nullable().default(null),
  })
  .strict();
export type InputExchange = z.infer<typeof InputExchangeSchema>;
```

Add to `RunSchema` after `awaitingQuestion` (line 166):

```ts
  // Durable Q&A history. `awaitingQuestion` stays the denormalised OPEN
  // question (cleared on resume); this survives every round trip.
  exchanges: z.array(InputExchangeSchema).default([]),
```

Add to `RunOutcomeSchema` after `summary` (line 177):

```ts
  handoff: HandoffBriefSchema.nullable().default(null),
```

- [ ] **Step 4:** in `src/server/outcome.server.ts`, make `readOutcome` tolerate a
malformed handoff **without** failing the outcome. Parse the outcome as today,
then re-parse the handoff defensively:

```ts
// Fail-OPEN on the handoff only: the outcome itself stays fail-closed, but a
// runner that emits a malformed brief must not have its needs_input downgraded
// to a failure.
const handoff = HandoffBriefSchema.safeParse(raw?.handoff);
outcome.handoff = handoff.success ? handoff.data : null;
```

Adjust to the file's actual parse flow; the requirement is behavioural, not
literal — a malformed `handoff` must yield `handoff: null` with
`outcome: "needs_input"` intact.

- [ ] **Step 5:** add a test for exactly that to
`src/server/outcome.smoke.test.ts` (a `needs_input` outcome file whose `handoff`
is `"not an object"` → `outcome.outcome === "needs_input"`, `handoff === null`).

- [ ] **Step 6:** `bunx vitest run --no-file-parallelism && bun run typecheck`.

- [ ] **Step 7: commit.**

```bash
git add -A
git commit -m "feat(runs): typed handoff brief + versioned input exchange schemas"
```

---

## Task 4: Record the exchange when a run parks

**Files:**
- Modify: `src/server/supervisor.server.ts` (`parkTicketNeedsInput` 393-428, and its call site in `finishRun` ~line 535-550)
- Test: extend `src/server/needs-input.smoke.test.ts`

- [ ] **Step 1 (RED):** extend the existing smoke suite:

```ts
it("records an open exchange when the run parks", async () => {
  // …existing bootstrap that drives a run to a needs_input outcome, with the
  // fake runner's outcome.json carrying a handoff:
  //   {"outcome":"needs_input","question":"Which base branch?",
  //    "handoff":{"workDone":"read the router","decision":"base branch"}}
  const run = await runs.findOne({ _id: new ObjectId(runId) });
  expect(run?.exchanges).toHaveLength(1);
  expect(run?.exchanges[0]).toMatchObject({
    v: 1,
    question: "Which base branch?",
    answer: null,
    answeredAt: null,
  });
  expect(run?.exchanges[0].handoff?.workDone).toBe("read the router");
  // The denormalised open question is unchanged.
  expect(run?.awaitingQuestion).toBe("Which base branch?");
});
```

- [ ] **Step 2: verify it fails.**

- [ ] **Step 3: implement.** Give `parkTicketNeedsInput` a `handoff` parameter
and push the exchange in the **same** update that sets `awaiting_input`:

```ts
async function parkTicketNeedsInput(
  database: Db,
  runId: string,
  ticketId: string,
  question: string,
  summary: string | null,
  handoff: HandoffBrief | null,
  at: string,
): Promise<void> {
  await database.collection<RunDoc>("runs").updateOne(
    {
      _id: new ObjectId(runId),
      status: { $in: ["queued", "running", "verifying"] },
    },
    {
      $set: { status: "awaiting_input", awaitingQuestion: question, summary },
      $push: {
        exchanges: {
          v: 1 as const,
          at,
          question,
          handoff,
          answer: null,
          answeredAt: null,
        },
      },
    },
  );
  // …ticket update below unchanged…
}
```

Pass `outcome.handoff` from the `finishRun` call site.

- [ ] **Step 4:** `bunx vitest run --no-file-parallelism && bun run typecheck`.

- [ ] **Step 5: commit.**

```bash
git add -A
git commit -m "feat(runs): push an open input exchange when a run parks"
```

---

## Task 5: Record the answer atomically with the resume claim

**This is the concurrency-critical task.** Read it fully before writing code.

**Files:**
- Modify: `src/server/supervisor.server.ts` (`resumeRun` claim 763-771; `restoreParkedResume` 675-710)
- Test: extend `src/server/needs-input.smoke.test.ts`

**Design rationale you must preserve:** the `awaiting_input → running` CAS claim
already serialises concurrent answers. Writing the answer *in that same update*
makes it atomic with the claim on standalone Mongo, with no second write to
lose. Do **not** add a separate `updateOne` for the answer.

- [ ] **Step 1 (RED):** extend the smoke suite with three tests:

```ts
it("records the answer on the open exchange, atomically with the claim", async () => {
  await provideInputCore({ ticketId, answer: "use develop" });
  const run = await runs.findOne({ _id: new ObjectId(runId) });
  expect(run?.exchanges[0].answer).toBe("use develop");
  expect(run?.exchanges[0].answeredAt).not.toBeNull();
  expect(run?.awaitingQuestion).toBeNull();   // cleared on successful spawn
});

it("lets exactly one of two concurrent answers win", async () => {
  const results = await Promise.allSettled([
    provideInputCore({ ticketId, answer: "A" }),
    provideInputCore({ ticketId, answer: "B" }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const run = await runs.findOne({ _id: new ObjectId(runId) });
  const answered = run?.exchanges.filter((e) => e.answer !== null) ?? [];
  expect(answered).toHaveLength(1);   // never two answers on one question
});

it("resumes a legacy parked run that has no exchanges", async () => {
  // Force the pre-v5 shape, then answer it.
  await runs.updateOne({ _id: new ObjectId(runId) }, { $set: { exchanges: [] } });
  await expect(provideInputCore({ ticketId, answer: "ok" })).resolves.toBeTruthy();
});
```

- [ ] **Step 2: verify they fail.**

- [ ] **Step 3: implement the claim.** Replace the claim at 763-771:

```ts
  const answeredAt = now();
  const claimed = await runs
    .updateOne(
      { _id: new ObjectId(runId), status: "awaiting_input" },
      {
        $set: {
          status: "running",
          startedAt: answeredAt,
          "exchanges.$[open].answer": answer,
          "exchanges.$[open].answeredAt": answeredAt,
        },
      },
      { arrayFilters: [{ "open.answer": null }] },
    )
    .catch(async () => {
      await restoreParkedResume(database, run, runId, run.awaitingQuestion);
      throw new ServerResultError("spawn_failed", "run could not be resumed");
    });
```

**Legacy safety:** MongoDB errors only when an `arrayFilters` identifier is
*unused in the update document*. Matching **zero** array elements is not an
error — it simply leaves the array untouched. So a legacy run with
`exchanges: []` resumes fine through this same update, recording no history.
That is why the third test above exists; do not add a special case for it.

- [ ] **Step 4: implement the compensation.** In `restoreParkedResume`, do
**not** revert the recorded answer — the human really did answer, and erasing it
would make the history lie. Instead push a **new open exchange carrying the same
question**, so history reads: asked → answered → spawn failed → asked again, and
the "open = last with `answer === null`" invariant holds.

Add to the runs `updateOne` inside `restoreParkedResume`:

```ts
      $push: {
        exchanges: {
          v: 1 as const,
          at,
          question: question ?? "",
          handoff: null,
          answer: null,
          answeredAt: null,
        },
      },
```

- [ ] **Step 5:** add a compensation test — force the spawn to fail (point the
runner at a non-existent binary), answer the run, then assert the run is parked
again with `exchanges.length === 2`, `exchanges[0].answer === "…"` preserved, and
`exchanges[1].answer === null` carrying the same question.

- [ ] **Step 6:** `bunx vitest run --no-file-parallelism && bun run typecheck`.

- [ ] **Step 7: commit.**

```bash
git add -A
git commit -m "feat(runs): record the answer atomically with the resume claim"
```

---

## Task 6: Ask runners for a handoff brief

**Files:**
- Modify: `src/runners/brief.ts` (the `needs_input` contract, lines 35-37)
- Test: `src/runners/brief.test.ts` (extend, or create if absent)

- [ ] **Step 1 (RED):** assert the execute-phase prompt contains `"handoff"`,
the words `filesTouched` and `options`, and states that the handoff is required
when the outcome is `needs_input`. Assert the `spec_draft` prompt is unchanged.

- [ ] **Step 2:** replace the two contract lines in `buildPrompt`:

```ts
    `When you finish, write this JSON to ${brief.outcomePath ?? "<runDir>/outcome.json"} and nothing else to it:`,
    `{"outcome":"completed|needs_input|failed","question":"<required if needs_input>","reason":"<optional>","summary":"<=10 lines","handoff":{"workDone":"…","filesTouched":["…"],"commandsRun":["…"],"decision":"…","options":["…"],"risk":"…"}}`,
    `Use "needs_input" ONLY for a genuine decision you cannot make under the locked spec; put the exact question in "question". When the outcome is "needs_input" you must also fill "handoff" so a human can pick up where you stopped: what you did, which files you touched, which commands you ran, the decision you need, the options you see, and the risk of each. Omit "handoff" for other outcomes. Use "completed" when the work is done and committed; "failed" if you cannot proceed. Do not ask for confirmation of work you can just do.`,
```

- [ ] **Step 3:** tests + typecheck green. **Step 4: commit** `feat(runners): require a handoff brief with needs_input`.

---

## Task 7: Surface the Q&A thread

**Files:**
- Modify: `src/server/runs.ts` (`RunDTOSchema`), `src/server/runs.server.ts` (`toDTO` pick), `src/components/RunsSection.tsx` (the parked block at 212-254)
- Test: `src/components/runsUi.test.ts` (extend)

- [ ] **Step 1:** add `exchanges: z.array(InputExchangeSchema)` to `RunDTOSchema`
and to the **explicit pick** in `toDTO`. The DTO is `.strict()` — omitting the
pick throws at the boundary.

> **Default it at the pick: `exchanges: doc.exchanges ?? []`.** This is not
> optional polish. `RunSchema.parse` is called only from tests; every production
> read (`listRunsCore`, `logTailCore`, `resumeRun`) uses raw `find`/`findOne`,
> so `RunSchema`'s `.default([])` never runs against stored data. A run written
> before this slice has **no `exchanges` key**, destructures to `undefined`, and
> a non-optional DTO field rejects it — which `boundary` turns into
> `code:"internal"`, erasing the **whole** runs list for that ticket. This exact
> bug shipped in Task 2 with `stderrFile` and was caught only in review.
>
> Test it with a document whose key is **genuinely absent** — build the object
> without the key. A fixture that sets `exchanges: []` explicitly is the
> post-migration shape and proves nothing.

- [ ] **Step 2 (RED):** add a pure helper in `src/components/runsUi.ts` plus tests:

```ts
export function answeredExchanges(exchanges: InputExchange[]): InputExchange[] {
  return exchanges.filter((e) => e.answer !== null);
}
export function openExchange(exchanges: InputExchange[]): InputExchange | null {
  const open = exchanges.filter((e) => e.answer === null);
  return open.length > 0 ? open[open.length - 1] : null;
}
```

Test: empty history → `null` open, `[]` answered; one open → returned; two
answered + one open → correct split; **all answered → `openExchange` is `null`**.

- [ ] **Step 3:** render in `RunsSection.tsx`, above the existing answer form:
answered exchanges as a compact thread (question, answer, timestamp), and the
open exchange's `handoff` — when non-null — in a `<details>` block titled
"What the run did" listing `workDone`, `filesTouched`, `commandsRun`,
`decision`, `options`, `risk`. Skip empty fields. Match the existing zinc
styling. **The question still renders from `parkedRun.awaitingQuestion`**, not
from the exchange, so a run parked before this slice remains answerable.

- [ ] **Step 4:** `bunx vitest run --no-file-parallelism && bun run typecheck && bun run build`.

- [ ] **Step 5: commit** `feat(ui): render the input exchange thread and handoff brief`.

---

# LAYER 2 — Consultation chat

## Task 8: `redactSecrets`

**This is the control that makes log-into-chat safe. Do not weaken it.**

**Files:**
- Create: `src/server/redact.ts`, `src/server/redact.test.ts`

- [ ] **Step 1 (RED): write the failing tests.**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { redactSecrets } from "./redact";

const ORIGINAL = { ...process.env };
afterEach(() => { process.env = { ...ORIGINAL }; });

describe("redactSecrets", () => {
  it("scrubs a live env secret wherever it appears", () => {
    process.env.MY_API_TOKEN = "s3cr3t-value-9999";
    const out = redactSecrets("curl -H 'x: s3cr3t-value-9999' https://x");
    expect(out).not.toContain("s3cr3t-value-9999");
    expect(out).toContain("[REDACTED]");
  });

  it("ignores short env values so common substrings survive", () => {
    process.env.SOME_KEY = "abc";           // < 8 chars
    expect(redactSecrets("abc def abc")).toBe("abc def abc");
  });

  it("ignores env vars whose name is not secret-shaped", () => {
    process.env.NODE_ENV = "development-mode";
    expect(redactSecrets("development-mode")).toBe("development-mode");
  });

  it.each([
    ["sk-abcdefghijklmnopqrstuvwx"],
    ["ghp_abcdefghijklmnopqrstuvwxyz12"],
    ["AKIAIOSFODNN7EXAMPLE"],
    ["Bearer abcdefghijklmnopqrstuvwxyz"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.dBjftJeZ4CVPmB92K27uhbUJU1p1r"],
  ])("scrubs shape-detected secret %s", (secret) => {
    const out = redactSecrets(`token=${secret} end`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("end");
  });

  it("leaves ordinary text untouched", () => {
    const text = "ran bun test, 199 passed, committed as a1e50cb";
    expect(redactSecrets(text)).toBe(text);
  });
});
```

- [ ] **Step 2: verify it fails.**

- [ ] **Step 3: implement `src/server/redact.ts`.**

```ts
// Both execution and chat inherit the full server env, so run logs can contain
// live credentials. A consultation transcript is persisted and may be shared,
// so every section of a context package passes through here first.
const SECRET_NAME = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
const MIN_SECRET_LENGTH = 8;
const REDACTED = "[REDACTED]";

const SHAPES: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{20,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactSecrets(text: string): string {
  let out = text;
  // Env-derived first: this catches the ACTUAL live secrets regardless of shape.
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (!SECRET_NAME.test(name)) continue;
    out = out.replace(new RegExp(escapeRegExp(value), "g"), REDACTED);
  }
  for (const shape of SHAPES) out = out.replace(shape, REDACTED);
  return out;
}
```

- [ ] **Step 4:** tests pass; typecheck. **Step 5: commit** `feat(server): secret redaction for consultation context`.

---

## Task 9: `buildRunContext`

**Files:**
- Create: `src/server/runContext.server.ts`, `src/server/runContext.smoke.test.ts`

- [ ] **Step 1 (RED): write the failing tests.** Assert, against a real-Mongo run:

1. The package always contains the ticket title, intent, and acceptance criteria.
2. It contains the open question and every answered exchange.
3. It contains the handoff brief fields when present.
4. With `process.env.T4D_TEST_TOKEN = "planted-secret-1234"` planted in the run's
   log file, the package contains **neither** that value **nor** the string
   `planted-secret`.
5. With an oversized synthetic history, the total length is
   `<= RUN_CONTEXT_CHAR_BUDGET + <spec length>`, the spec is still present, and
   the **newest** exchange survives while the oldest is dropped.
6. Sections are dropped whole: the package never ends mid-section — assert that
   every section header present is followed by content.

- [ ] **Step 2: verify it fails.**

- [ ] **Step 3: implement.** Priority order is load-bearing — later sections are
dropped entirely when budget runs out, never half-included.

```ts
export const RUN_CONTEXT_CHAR_BUDGET = 48_000;   // ≈12k tokens

export async function buildRunContext(runId: string): Promise<{ text: string }> {
  // 1. Locked spec — ALWAYS included, exempt from the cap. A package without
  //    the spec is meaningless, so there is nothing to trade off against.
  // 2. Exchange history, NEWEST FIRST so the freshest round trips survive.
  // 3. Handoff brief of the open exchange.
  // 4. Objective worktree facts: branch, baseSha, `git status --porcelain`,
  //    `git log --oneline <baseSha>..HEAD` — execFile with an argv array and
  //    NO shell, matching the BoardCheck execution rule. A git failure degrades
  //    that section to a one-line note; it never fails the build.
  // 5. Redacted log excerpt: tail of logFile then stderrFile, budget permitting.
  //
  // EVERY section passes through redactSecrets before it is appended, including
  // 1-3: a runner can echo a secret into its own handoff. If redactSecrets
  // throws, omit that section entirely rather than emit it raw (fail-closed).
}
```

Build sections into an array of `{header, body}`, redact each, then append while
`total + section.length <= RUN_CONTEXT_CHAR_BUDGET`, skipping (not truncating)
any section that would overflow. The spec section is appended before the budget
loop begins.

- [ ] **Step 4:** tests pass; `bunx vitest run --no-file-parallelism && bun run typecheck`.
- [ ] **Step 5: commit** `feat(server): bounded, redacted run context builder`.

---

## Task 10: Consultation sessions

**Files:**
- Modify: `src/domain/schemas.ts` (`ChatSessionSchema`), `src/server/chat.server.ts`, `src/server/chat.ts`, `src/server/chatCommand.ts`, `src/queries/chat.ts`
- Test: `src/server/consultation.smoke.test.ts` (create)

- [ ] **Step 1: verify the Claude read-only question before writing code.**

```bash
claude --help 2>&1 | grep -iE "allowed-?tools|disallowed-?tools|permission-mode|sandbox" || echo "NO TOOL RESTRICTION FLAG FOUND"
```

Record the result in a comment in `chatCommand.ts`. **If a flag exists, use it.
If not, do NOT invent one** — the scratch-cwd containment below stands alone.
Guessing at a safety flag is worse than not relying on one.

- [ ] **Step 2:** extend `ChatSessionSchema`:

```ts
  kind: z.enum(["brainstorm", "consultation"]).default("brainstorm"),
  runId: ObjectIdString.nullable().default(null),
```

Add both to `ChatSessionDTOSchema` (`src/server/chat.ts:21-35`) and to the
explicit pick in `chatToDTO`.

- [ ] **Step 3 (RED): write the failing smoke tests.**

1. `createConsultationSessionCore({runId})` on a run in `awaiting_input` creates
   a session with `kind: "consultation"`, `runId` set, and a first message whose
   text contains the ticket intent and the open question.
2. The same call on a run **not** in `awaiting_input` throws `conflict`.
3. A secret planted in the run's log does **not** appear in the seeded message.
4. The consultation session's spawn `cwd` is the scratch dir, not `board.repoPath`.

- [ ] **Step 4:** implement `createConsultationSessionCore`:

```ts
export async function createConsultationSessionCore(input: {
  runId: string;
  provider?: "claude" | "codex";
}): Promise<{ id: string }> {
  const run = await loadRun(input.runId);
  if (run.status !== "awaiting_input") {
    throw new ServerResultError("conflict", "run is not awaiting input");
  }
  const context = await buildRunContext(input.runId);
  // Seed the package as the opening user message so it is visible to the human
  // and carried by the provider's own session from the first turn.
  // …insert a session doc with kind:"consultation", runId, and messages:[{role:"user", text:context.text, at}]…
}
```

- [ ] **Step 5: containment.** A consultation turn spawns with `cwd` set to a
dedicated empty scratch directory (`<runDir>/consult/`, created with `mkdir
{recursive:true}`), **not** the worktree and not `board.repoPath`. Rationale
(from the spec): it is provider-agnostic, does not rest on an unverified CLI
sandbox flag, and makes "cannot damage the run" true by construction rather than
by configuration. Codex additionally keeps its existing `-s read-only`.

In `startChatTurn`, replace the hardcoded `cwd: board.repoPath` (line 227) with
the session's working directory — `board.repoPath` for brainstorm sessions, the
scratch dir for consultation sessions. Pass the same value to
`buildChatCommand`'s `repoPath` parameter so codex's `-C` matches.

- [ ] **Step 6:** expose `createConsultationSession` as a server fn in
`src/server/chat.ts` (`.strict()` input `{runId, provider?}`) plus a
`useCreateConsultationSession` hook in `src/queries/chat.ts`.

**There must be no server fn that lets a consultation session touch a run or a
ticket.** The answer path stays `provideInput` → `resumeRun`, pressed by a human.

- [ ] **Step 7:** `bunx vitest run --no-file-parallelism && bun run typecheck`.
- [ ] **Step 8: commit** `feat(chat): read-only consultation sessions seeded from run context`.

---

## Task 11: Consultation UI

**Files:**
- Modify: `src/components/RunsSection.tsx`, `src/routes/b/$boardSlug/chat/$sessionId.tsx`

- [ ] **Step 1:** in the parked block, add a **Consult** button next to the
answer form. It calls `useCreateConsultationSession({runId})` and navigates to
the chat route. Match existing zinc button styling.

- [ ] **Step 2:** in the chat route, when `session.kind === "consultation"`,
show a header noting it is advisory and read-only, and render a **Use as my
answer** action on assistant messages that copies the text back into the run's
answer textarea (via router state or a query param the ticket view reads).

**The copy must not submit.** The human still presses **Provide input**.

- [ ] **Step 3:** hide the bundle/propose affordances for consultation sessions —
a consultation never produces tickets.

- [ ] **Step 4:** `bunx vitest run --no-file-parallelism && bun run typecheck && bun run build`.
- [ ] **Step 5: commit** `feat(ui): consult a second AI while answering a parked run`.

---

## Task 12: Final gate

- [ ] **Step 1:**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run test && bun run typecheck && bun run build && echo GATE_OK
```

If `bun run test` reports failures, re-check with
`bunx vitest run --no-file-parallelism` before treating them as real — parallel
smoke suites contend on standalone Mongo.

- [ ] **Step 2:** manual check — park a run on a question, confirm the Q&A thread
and handoff render, open a consultation, confirm the seeded context contains the
spec and question and no credentials, copy an answer back, and confirm the run
resumes.

---

## Self-review

- **Spec coverage:** Layer 0 → Tasks 1-2. Layer 1 schemas → 3, writes → 4-5,
  prompt → 6, UI → 7. Layer 2 redaction → 8, context builder → 9, sessions → 10,
  UI → 11. Migration is covered by defaults asserted in Tasks 3, 5 (legacy
  `exchanges: []`), and 7 (question still read from `awaitingQuestion`).
- **Concurrency:** the only new write to a parked run rides the existing CAS
  claim (Task 5), tested with two concurrent answers.
- **Fail-closed vs fail-open:** outcome stays fail-closed; the handoff is
  explicitly fail-open (Task 3) and redaction failure drops the section (Task 9).
- **Type consistency:** `HandoffBriefSchema` / `InputExchangeSchema` are defined
  once in Task 3 and referenced by name in 4, 5, 7, 9. `parkTicketNeedsInput`
  gains its `handoff` parameter in Task 4 and is not renamed thereafter.
- **Unverified-flag risk** is contained: Task 10 Step 1 makes the Claude
  read-only flag a *check*, and the design does not depend on the answer.
