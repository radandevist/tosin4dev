import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Collection, type Db, type WithId } from "mongodb";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  InputExchangeSchema,
  type Board,
  type Run,
  type Ticket,
} from "../domain/schemas";

type BoardDoc = Board & { createdAt: string; updatedAt: string };
type TicketDoc = Ticket & { createdAt: string; updatedAt: string };
type RunDoc = Run & {
  pid: number | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

const TEST_DB = `tosin4dev-test-needs-input-${process.pid}-${Date.now()}`;
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const ORIGINAL_OUTCOME = process.env.T4D_OUTCOME;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;
process.env.DISCORD_WEBHOOK_URL = "";

const { db, closeDb, ObjectId } = await import("./db");
const { dispatchRun, parkTicketNeedsInput } = await import(
  "./supervisor.server"
);

let database: Db;
let boards: Collection<BoardDoc>;
let tickets: Collection<TicketDoc>;
let runs: Collection<RunDoc>;
let repo: string;
let binDirectory: string;
let boardId: string;

const timestamp = () => new Date().toISOString();

function rejectRunUpdate(
  runId: string,
  ordinal: number,
): ReturnType<typeof vi.spyOn> {
  const originalUpdateOne = Collection.prototype.updateOne;
  let runUpdates = 0;
  return vi
    .spyOn(Collection.prototype, "updateOne")
    .mockImplementation(function (
      this: Collection,
      filter,
      update,
      options,
    ) {
      const id = (filter as { _id?: { toString(): string } })._id;
      if (this.collectionName === "runs" && id?.toString() === runId) {
        runUpdates += 1;
        if (runUpdates === ordinal) {
          return Promise.reject(new Error(`injected run update ${ordinal}`));
        }
      }
      return originalUpdateOne.call(this, filter, update, options);
    });
}

function pauseNextResumeClaim(runId: string): {
  reached: Promise<void>;
  release: () => void;
  spy: ReturnType<typeof vi.spyOn>;
} {
  const originalUpdateOne = Collection.prototype.updateOne;
  let reachedResolve!: () => void;
  let releaseResolve!: () => void;
  let paused = false;
  const reached = new Promise<void>((resolve) => {
    reachedResolve = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const spy = vi
    .spyOn(Collection.prototype, "updateOne")
    .mockImplementation(async function (
      this: Collection,
      filter,
      update,
      options,
    ) {
      const id = (filter as { _id?: { toString(): string } })._id;
      const status = (filter as { status?: unknown }).status;
      const nextStatus = (
        update as { $set?: { status?: unknown } }
      ).$set?.status;
      if (
        !paused &&
        this.collectionName === "runs" &&
        id?.toString() === runId &&
        status === "awaiting_input" &&
        nextStatus === "running"
      ) {
        paused = true;
        reachedResolve();
        await release;
      }
      return originalUpdateOne.call(this, filter, update, options);
    });
  return { reached, release: releaseResolve, spy };
}

async function writeRunner(): Promise<void> {
  const executable = join(binDirectory, "claude");
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s\\n' '{"type":"result","session_id":"s-smoke","result":"ok"}'
echo "artifact $$" > artifact.txt
git add -A
git commit -m "work" >/dev/null 2>&1
if [ -n "$T4D_OUTCOME" ]; then
  printf '%s' "$T4D_OUTCOME" > "$T4D_OUTCOME_PATH"
fi
exit 0
`,
  );
  await chmod(executable, 0o755);
}

async function insertApproved(seq: number): Promise<string> {
  const at = timestamp();
  const result = await tickets.insertOne({
    boardId,
    seq,
    title: `outcome ${seq}`,
    type: "implement",
    status: "approved",
    runner: "claude",
    spec: {
      intent: "exercise runner outcomes",
      scope: "",
      nonGoals: "",
      acceptance: [],
      links: [],
      risk: "low",
      approvedAt: at,
      approvedBy: "radan",
    },
    activeRunId: null,
    prUrl: null,
    activity: [],
    dependsOn: [],
    createdAt: at,
    updatedAt: at,
  });
  return result.insertedId.toString();
}

async function waitForRun(
  runId: string,
  expected: Run["status"],
  timeoutMs = 15_000,
): Promise<WithId<RunDoc>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await runs.findOne({ _id: new ObjectId(runId) });
    if (run?.status === expected) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} did not reach ${expected}`);
}

describe("runner outcomes", () => {
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "t4d-outcome-repo-"));
    binDirectory = await mkdtemp(join(tmpdir(), "t4d-outcome-bin-"));
    execFileSync("git", ["init", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    await writeFile(join(repo, "README.md"), "x\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "init"]);
    process.env.PATH = `${binDirectory}:${ORIGINAL_PATH ?? ""}`;
    await writeRunner();
    database = await db();
    boards = database.collection<BoardDoc>("boards");
    tickets = database.collection<TicketDoc>("tickets");
    runs = database.collection<RunDoc>("runs");
    const at = timestamp();
    const board = await boards.insertOne({
      slug: `outcomes-${process.pid}-${Date.now()}`,
      name: "Outcomes",
      repoPath: repo,
      defaultBaseBranch: "main",
      checks: [
        {
          key: "git",
          label: "git",
          command: ["git", "--version"],
          timeoutMs: 10_000,
        },
      ],
      createdAt: at,
      updatedAt: at,
    });
    boardId = board.insertedId.toString();
  });

  beforeEach(async () => {
    process.env.PATH = `${binDirectory}:${ORIGINAL_PATH ?? ""}`;
    delete process.env.T4D_OUTCOME;
    await writeRunner();
    await tickets.deleteMany({});
    await runs.deleteMany({});
  });

  afterAll(async () => {
    await database?.dropDatabase();
    await closeDb();
    process.env.PATH = ORIGINAL_PATH;
    process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;
    process.env.DISCORD_WEBHOOK_URL = ORIGINAL_WEBHOOK;
    process.env.T4D_OUTCOME = ORIGINAL_OUTCOME;
    await Promise.all([
      rm(repo, { recursive: true, force: true }),
      rm(binDirectory, { recursive: true, force: true }),
    ]);
  });

  it("parks a needs_input outcome with its question and session id", async () => {
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Q?",
    });
    const ticketId = await insertApproved(1);
    const { runId } = await dispatchRun(ticketId, "execute");

    const run = await waitForRun(runId, "awaiting_input");
    const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });

    expect(ticket?.status).toBe("needs_input");
    expect(run.awaitingQuestion).toBe("Q?");
    expect(ticket?.activeRunId).toBe(runId);
    expect(run.executionSessionId).toBe("s-smoke");
    expect(run.exchanges).toHaveLength(1);
    expect(run.exchanges[0]).toMatchObject({
      v: 1,
      question: "Q?",
      handoff: null,
      answer: null,
      answeredAt: null,
    });
    expect(run.exchanges[0]?.at).toBe(ticket?.updatedAt);
    expect(run.exchanges[0]?.at).toBe(ticket?.activity.at(-1)?.at);
  }, 20_000);

  it("ignores a duplicate park after the run is already parked", async () => {
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Q?",
    });
    const ticketId = await insertApproved(11);
    const { runId } = await dispatchRun(ticketId, "execute");
    const parkedRun = await waitForRun(runId, "awaiting_input");
    const parkedTicket = await tickets.findOne({
      _id: new ObjectId(ticketId),
    });

    await parkTicketNeedsInput(
      database,
      runId,
      ticketId,
      "Q?",
      parkedRun.summary,
      null,
      timestamp(),
    );

    const run = await runs.findOne({ _id: new ObjectId(runId) });
    const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
    expect(run?.exchanges).toHaveLength(1);
    expect(ticket?.activity).toEqual(parkedTicket?.activity);
  }, 20_000);

  it("records an open exchange with its handoff when the run parks", async () => {
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Which base branch?",
      handoff: {
        workDone: "read the router",
        decision: "base branch",
      },
    });
    const ticketId = await insertApproved(6);
    const { runId } = await dispatchRun(ticketId, "execute");

    const run = await waitForRun(runId, "awaiting_input");
    const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });

    expect(ticket?.status).toBe("needs_input");
    expect(run.exchanges).toHaveLength(1);
    expect(run.exchanges[0]).toMatchObject({
      v: 1,
      question: "Which base branch?",
      answer: null,
      answeredAt: null,
    });
    expect(run.exchanges[0]?.handoff?.workDone).toBe("read the router");
    expect(run.awaitingQuestion).toBe("Which base branch?");
  }, 20_000);

  it("parks needs_input when the handoff is malformed", async () => {
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Malformed handoff question?",
      handoff: "not an object",
    });
    const ticketId = await insertApproved(12);
    const { runId } = await dispatchRun(ticketId, "execute");

    const run = await waitForRun(runId, "awaiting_input");
    const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
    expect(run.status).toBe("awaiting_input");
    expect(ticket?.status).toBe("needs_input");
    expect(run.exchanges).toHaveLength(1);
    expect(run.exchanges[0]?.handoff).toBeNull();
  }, 20_000);

  it("caps exchange history at 50 while retaining the newest park", async () => {
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Initial question?",
    });
    const ticketId = await insertApproved(13);
    const { runId } = await dispatchRun(ticketId, "execute");
    await waitForRun(runId, "awaiting_input");

    const historyAt = timestamp();
    const history: Run["exchanges"] = Array.from(
      { length: 50 },
      (_, index) => ({
        v: 1,
        at: historyAt,
        question: `History ${index}`,
        handoff: null,
        answer: `Answer ${index}`,
        answeredAt: historyAt,
      }),
    );
    await runs.updateOne(
      { _id: new ObjectId(runId) },
      {
        $set: {
          status: "running",
          awaitingQuestion: null,
          exchanges: history,
        },
      },
    );
    await tickets.updateOne(
      { _id: new ObjectId(ticketId) },
      { $set: { status: "running" } },
    );

    const parkAt = "2040-01-02T03:04:05.000Z";
    await parkTicketNeedsInput(
      database,
      runId,
      ticketId,
      "Newest question?",
      null,
      null,
      parkAt,
    );

    const run = await runs.findOne({ _id: new ObjectId(runId) });
    const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
    expect(run?.exchanges).toHaveLength(50);
    expect(run?.exchanges[0]?.question).toBe("History 1");
    expect(run?.exchanges.at(-1)).toMatchObject({
      at: parkAt,
      question: "Newest question?",
      answer: null,
    });
    expect(ticket?.updatedAt).toBe(parkAt);
    expect(ticket?.activity.at(-1)?.at).toBe(parkAt);
  }, 20_000);

  it("resumes a needs_input ticket and completes on the answer", async () => {
    const { provideInputCore } = await import("./tickets.server");
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Which auth library?",
    });
    const ticketId = await insertApproved(2);
    const { runId } = await dispatchRun(ticketId, "execute");
    const parkedRun = await waitForRun(runId, "awaiting_input");
    const originalWorkDir = parkedRun.workDir;
    const originalBranch = parkedRun.branch;

    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "completed",
      summary: "done",
    });
    await provideInputCore({ ticketId, answer: "use lucia" });

    const run = await waitForRun(runId, "succeeded");
    const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
    expect(ticket?.status).toBe("review_ready");
    expect(run.verdict).toBe("passed");
    expect(run.workDir).toBe(originalWorkDir);
    expect(run.branch).toBe(originalBranch);
    expect(run.executionSessionId).toBe("s-smoke");
  }, 20_000);

  it("records the answer on the open exchange atomically with the claim", async () => {
    const { provideInputCore } = await import("./tickets.server");
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Which base branch?",
    });
    const ticketId = await insertApproved(7);
    const { runId } = await dispatchRun(ticketId, "execute");
    await waitForRun(runId, "awaiting_input");

    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "completed",
      summary: "done",
    });
    await provideInputCore({ ticketId, answer: "use develop" });

    const claimedRun = await runs.findOne({ _id: new ObjectId(runId) });
    expect(claimedRun?.exchanges[0]?.answer).toBe("use develop");
    expect(claimedRun?.exchanges[0]?.answeredAt).not.toBeNull();
    expect(claimedRun?.awaitingQuestion).toBeNull();
    await waitForRun(runId, "succeeded");
  }, 20_000);

  it("lets exactly one of two concurrent answers win", async () => {
    const { provideInputCore } = await import("./tickets.server");
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Which answer?",
    });
    const ticketId = await insertApproved(8);
    const { runId } = await dispatchRun(ticketId, "execute");
    await waitForRun(runId, "awaiting_input");

    process.env.T4D_OUTCOME = JSON.stringify({ outcome: "completed" });
    const results = await Promise.allSettled([
      provideInputCore({ ticketId, answer: "A" }),
      provideInputCore({ ticketId, answer: "B" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    const run = await runs.findOne({ _id: new ObjectId(runId) });
    const answered =
      run?.exchanges.filter((exchange) => exchange.answer !== null) ?? [];
    expect(answered).toHaveLength(1);
    expect(["A", "B"]).toContain(answered[0]?.answer);
    await waitForRun(runId, "succeeded");
  }, 20_000);

  it("resumes a legacy parked run that has no exchanges", async () => {
    const { provideInputCore } = await import("./tickets.server");
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Legacy question?",
    });
    const ticketId = await insertApproved(9);
    const { runId } = await dispatchRun(ticketId, "execute");
    await waitForRun(runId, "awaiting_input");
    await runs.updateOne(
      { _id: new ObjectId(runId) },
      { $unset: { exchanges: "" } },
    );

    process.env.T4D_OUTCOME = JSON.stringify({ outcome: "completed" });
    await expect(
      provideInputCore({ ticketId, answer: "ok" }),
    ).resolves.toBeTruthy();
    const run = await waitForRun(runId, "succeeded");
    expect(run.exchanges).toHaveLength(1);
    expect(run.exchanges[0]).toMatchObject({
      v: 1,
      question: "Legacy question?",
      handoff: null,
      answer: "ok",
    });
    expect(run.exchanges[0]?.answeredAt).not.toBeNull();
  }, 20_000);

  it("resumes a parked run with an empty exchanges array", async () => {
    const { provideInputCore } = await import("./tickets.server");
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Post-migration question?",
    });
    const ticketId = await insertApproved(15);
    const { runId } = await dispatchRun(ticketId, "execute");
    await waitForRun(runId, "awaiting_input");
    await runs.updateOne(
      { _id: new ObjectId(runId) },
      { $set: { exchanges: [] } },
    );

    process.env.T4D_OUTCOME = JSON.stringify({ outcome: "completed" });
    await expect(
      provideInputCore({ ticketId, answer: "ok" }),
    ).resolves.toBeTruthy();
    await waitForRun(runId, "succeeded");
  }, 20_000);

  it("answers only the last open exchange", async () => {
    const { provideInputCore } = await import("./tickets.server");
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Q2?",
    });
    const ticketId = await insertApproved(16);
    const { runId } = await dispatchRun(ticketId, "execute");
    const parkedRun = await waitForRun(runId, "awaiting_input");
    await runs.updateOne(
      { _id: new ObjectId(runId) },
      {
        $set: {
          exchanges: [
            {
              ...parkedRun.exchanges[0]!,
              question: "Q1?",
            },
            parkedRun.exchanges[0]!,
          ],
        },
      },
    );

    process.env.T4D_OUTCOME = JSON.stringify({ outcome: "completed" });
    await provideInputCore({ ticketId, answer: "ANSWER-FOR-Q2" });
    const run = await waitForRun(runId, "succeeded");

    expect(run.exchanges[0]).toMatchObject({
      question: "Q1?",
      answer: null,
      answeredAt: null,
    });
    expect(run.exchanges[1]).toMatchObject({
      question: "Q2?",
      answer: "ANSWER-FOR-Q2",
    });
    expect(run.exchanges[1]?.answeredAt).not.toBeNull();
  }, 20_000);

  it("rejects a stale claim instead of overwriting an earlier answer", async () => {
    const { provideInputCore } = await import("./tickets.server");
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Q1?",
    });
    const ticketId = await insertApproved(20);
    const { runId } = await dispatchRun(ticketId, "execute");
    await waitForRun(runId, "awaiting_input");

    const paused = pauseNextResumeClaim(runId);
    const staleClaim = provideInputCore({
      ticketId,
      answer: "STALE-ANSWER",
    });
    await paused.reached;

    try {
      process.env.T4D_OUTCOME = JSON.stringify({
        outcome: "needs_input",
        question: "Q2?",
      });
      await provideInputCore({ ticketId, answer: "A1" });
      const reparked = await waitForRun(runId, "awaiting_input");
      expect(reparked.awaitingQuestion).toBe("Q2?");

      paused.release();
      await expect(staleClaim).rejects.toMatchObject({ code: "conflict" });
    } finally {
      paused.release();
      paused.spy.mockRestore();
    }

    const run = await runs.findOne({ _id: new ObjectId(runId) });
    expect(run?.exchanges).toMatchObject([
      { question: "Q1?", answer: "A1" },
      { question: "Q2?", answer: null, answeredAt: null },
    ]);
  }, 20_000);

  it("pins a stale capped-history claim to the snapshotted row", async () => {
    const { provideInputCore } = await import("./tickets.server");
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Capped Q1?",
    });
    const ticketId = await insertApproved(21);
    const { runId } = await dispatchRun(ticketId, "execute");
    const parked = await waitForRun(runId, "awaiting_input");
    const history: Run["exchanges"] = Array.from(
      { length: 49 },
      (_, index) => {
        const at = new Date(Date.UTC(2030, 0, 1, 0, 0, index)).toISOString();
        return {
          v: 1,
          at,
          question: `Capped history ${index}`,
          handoff: null,
          answer: `Answer ${index}`,
          answeredAt: at,
        };
      },
    );
    await runs.updateOne(
      { _id: new ObjectId(runId) },
      { $set: { exchanges: [...history, parked.exchanges[0]!] } },
    );

    const paused = pauseNextResumeClaim(runId);
    const staleClaim = provideInputCore({
      ticketId,
      answer: "WRONG-QUESTION-ANSWER",
    });
    await paused.reached;

    try {
      process.env.T4D_OUTCOME = JSON.stringify({
        outcome: "needs_input",
        question: "Capped Q2?",
      });
      await provideInputCore({ ticketId, answer: "A1" });
      const reparked = await waitForRun(runId, "awaiting_input");
      expect(reparked.awaitingQuestion).toBe("Capped Q2?");
      expect(reparked.exchanges).toHaveLength(50);

      process.env.T4D_OUTCOME = JSON.stringify({ outcome: "completed" });
      paused.release();
      await expect(staleClaim).rejects.toMatchObject({ code: "conflict" });
    } finally {
      paused.release();
      paused.spy.mockRestore();
    }

    const run = await runs.findOne({ _id: new ObjectId(runId) });
    expect(run?.exchanges.at(-2)).toMatchObject({
      question: "Capped Q1?",
      answer: "A1",
    });
    expect(run?.exchanges.at(-1)).toMatchObject({
      question: "Capped Q2?",
      answer: null,
      answeredAt: null,
    });
  }, 20_000);

  it("does not treat a missing answer field as an open row", async () => {
    const { provideInputCore } = await import("./tickets.server");
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Typed-null question?",
    });
    const ticketId = await insertApproved(22);
    const { runId } = await dispatchRun(ticketId, "execute");
    await waitForRun(runId, "awaiting_input");

    const paused = pauseNextResumeClaim(runId);
    const staleClaim = provideInputCore({
      ticketId,
      answer: "ANSWER-FOR-MISSING-FIELD",
    });
    await paused.reached;

    try {
      await runs.updateOne(
        { _id: new ObjectId(runId) },
        { $unset: { "exchanges.0.answer": "" } },
      );
      paused.release();
      await expect(staleClaim).rejects.toMatchObject({ code: "conflict" });
    } finally {
      paused.release();
      paused.spy.mockRestore();
    }

    const run = await runs.findOne({ _id: new ObjectId(runId) });
    expect(run?.exchanges[0]?.answer).toBeUndefined();
  }, 20_000);

  it("keeps at most one exchange open across answer and re-park", async () => {
    const { provideInputCore } = await import("./tickets.server");
    const openExchanges = (run: WithId<RunDoc> | null) =>
      run?.exchanges.filter((exchange) => exchange.answer === null) ?? [];

    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Q1?",
    });
    const ticketId = await insertApproved(10);
    const { runId } = await dispatchRun(ticketId, "execute");
    const firstPark = await waitForRun(runId, "awaiting_input");
    expect(openExchanges(firstPark)).toHaveLength(1);

    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Q2?",
    });
    await provideInputCore({ ticketId, answer: "A1" });

    const afterAnswer = await runs.findOne({ _id: new ObjectId(runId) });
    expect(openExchanges(afterAnswer).length).toBeLessThanOrEqual(1);
    expect(afterAnswer?.exchanges[0]?.answer).toBe("A1");

    const secondPark = await waitForRun(runId, "awaiting_input");
    expect(openExchanges(secondPark)).toHaveLength(1);
    expect(secondPark.exchanges).toHaveLength(2);
    expect(secondPark.exchanges[0]).toMatchObject({
      question: "Q1?",
      answer: "A1",
    });
    expect(secondPark.exchanges[1]).toMatchObject({
      question: "Q2?",
      answer: null,
    });

    process.env.T4D_OUTCOME = JSON.stringify({ outcome: "completed" });
    await provideInputCore({ ticketId, answer: "A2" });
    const completed = await waitForRun(runId, "succeeded");
    expect(openExchanges(completed)).toHaveLength(0);
    expect(completed.exchanges).toMatchObject([
      { question: "Q1?", answer: "A1" },
      { question: "Q2?", answer: "A2" },
    ]);
  }, 20_000);

  it("does not manufacture an exchange when the claim write fails", async () => {
    const { provideInputCore } = await import("./tickets.server");
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Still open?",
    });
    const ticketId = await insertApproved(17);
    const { runId } = await dispatchRun(ticketId, "execute");
    await waitForRun(runId, "awaiting_input");

    const updateSpy = rejectRunUpdate(runId, 1);
    try {
      await expect(
        provideInputCore({ ticketId, answer: "not recorded" }),
      ).rejects.toThrow("run could not be resumed");
    } finally {
      updateSpy.mockRestore();
    }

    const run = await runs.findOne({ _id: new ObjectId(runId) });
    expect(run?.status).toBe("awaiting_input");
    expect(run?.exchanges).toHaveLength(1);
    expect(run?.exchanges[0]).toMatchObject({
      question: "Still open?",
      answer: null,
      answeredAt: null,
    });
  }, 20_000);

  it("atomically restores parked status with the reopened exchange", async () => {
    const { provideInputCore } = await import("./tickets.server");
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Atomic reopen?",
    });
    const ticketId = await insertApproved(23);
    const { runId } = await dispatchRun(ticketId, "execute");
    await waitForRun(runId, "awaiting_input");

    await rm(join(binDirectory, "claude"), { force: true });
    process.env.PATH = binDirectory;
    const originalUpdateOne = Collection.prototype.updateOne;
    const restoreUpdates: Array<Record<string, unknown>> = [];
    const updateSpy = vi
      .spyOn(Collection.prototype, "updateOne")
      .mockImplementation(function (
        this: Collection,
        filter,
        update,
        options,
      ) {
        const id = (filter as { _id?: { toString(): string } })._id;
        const nextStatus = (
          update as { $set?: { status?: unknown } }
        ).$set?.status;
        if (
          this.collectionName === "runs" &&
          id?.toString() === runId &&
          nextStatus === "awaiting_input"
        ) {
          restoreUpdates.push(update as Record<string, unknown>);
        }
        return originalUpdateOne.call(this, filter, update, options);
      });
    try {
      await expect(
        provideInputCore({ ticketId, answer: "recorded" }),
      ).rejects.toMatchObject({ code: "spawn_failed" });
    } finally {
      updateSpy.mockRestore();
    }

    expect(restoreUpdates).toHaveLength(1);
    expect(restoreUpdates[0]).toHaveProperty("$push.exchanges");
    const run = await runs.findOne({ _id: new ObjectId(runId) });
    expect(
      run?.exchanges.filter((exchange) => exchange.answer === null),
    ).toHaveLength(1);
  }, 20_000);

  it("maps a claim failure even when compensation also fails", async () => {
    const { provideInputCore } = await import("./tickets.server");
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Mapped failure?",
    });
    const ticketId = await insertApproved(24);
    const { runId } = await dispatchRun(ticketId, "execute");
    await waitForRun(runId, "awaiting_input");

    const originalUpdateOne = Collection.prototype.updateOne;
    let runUpdates = 0;
    const updateSpy = vi
      .spyOn(Collection.prototype, "updateOne")
      .mockImplementation(function (
        this: Collection,
        filter,
        update,
        options,
      ) {
        const id = (filter as { _id?: { toString(): string } })._id;
        if (this.collectionName === "runs" && id?.toString() === runId) {
          runUpdates += 1;
          if (runUpdates <= 2) {
            return Promise.reject(
              new Error(`injected run update ${runUpdates}`),
            );
          }
        }
        return originalUpdateOne.call(this, filter, update, options);
      });
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await expect(
        provideInputCore({ ticketId, answer: "not recorded" }),
      ).rejects.toMatchObject({ code: "spawn_failed" });
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Failed to restore parked run ${runId}`),
        expect.any(Error),
      );
    } finally {
      consoleSpy.mockRestore();
      updateSpy.mockRestore();
    }
  }, 20_000);

  it("keeps the answer when the write after the claim fails", async () => {
    const { provideInputCore } = await import("./tickets.server");
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Atomic answer?",
    });
    const ticketId = await insertApproved(18);
    const { runId } = await dispatchRun(ticketId, "execute");
    await waitForRun(runId, "awaiting_input");

    const updateSpy = rejectRunUpdate(runId, 2);
    try {
      await expect(
        provideInputCore({ ticketId, answer: "preserved" }),
      ).rejects.toThrow();
    } finally {
      updateSpy.mockRestore();
    }

    const run = await runs.findOne({ _id: new ObjectId(runId) });
    expect(run?.exchanges[0]).toMatchObject({
      question: "Atomic answer?",
      answer: "preserved",
    });
    expect(run?.exchanges[0]?.answeredAt).not.toBeNull();
    expect(run?.status).toBe("awaiting_input");
    expect(run?.exchanges[1]).toMatchObject({
      question: "Atomic answer?",
      answer: null,
      answeredAt: null,
    });
  }, 20_000);

  it("leaves a failed resume parked and retryable when spawn fails", async () => {
    const { provideInputCore } = await import("./tickets.server");
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Which auth library?",
    });
    const ticketId = await insertApproved(3);
    const { runId } = await dispatchRun(ticketId, "execute");
    const parkedRun = await waitForRun(runId, "awaiting_input");
    const originalWorkDir = parkedRun.workDir;
    const originalBranch = parkedRun.branch;
    const originalExecutionSessionId = parkedRun.executionSessionId;

    await rm(join(binDirectory, "claude"), { force: true });
    process.env.PATH = binDirectory;
    await expect(
      provideInputCore({ ticketId, answer: "use lucia" }),
    ).rejects.toThrow();

    const run = await runs.findOne({ _id: new ObjectId(runId) });
    const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
    expect(ticket?.status).toBe("needs_input");
    expect(ticket?.activeRunId).toBe(runId);
    expect(run?.status).toBe("awaiting_input");
    expect(run?.awaitingQuestion).toBe("Which auth library?");
    expect(run?.pid).toBeNull();
    expect(run?.startedAt).toBe(parkedRun.startedAt);
    expect(run?.exchanges).toHaveLength(2);
    expect(run?.exchanges[0]).toMatchObject({
      question: "Which auth library?",
      answer: "use lucia",
    });
    expect(run?.exchanges[0]?.answeredAt).not.toBeNull();
    expect(run?.exchanges[1]).toMatchObject({
      question: "Which auth library?",
      answer: null,
      answeredAt: null,
    });

    process.env.PATH = `${binDirectory}:${ORIGINAL_PATH ?? ""}`;
    await writeRunner();
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "completed",
      summary: "done after retry",
    });
    await provideInputCore({ ticketId, answer: "use lucia" });

    const retriedRun = await waitForRun(runId, "succeeded");
    const retriedTicket = await tickets.findOne({
      _id: new ObjectId(ticketId),
    });
    expect(retriedTicket?.status).toBe("review_ready");
    expect(retriedRun._id.toString()).toBe(runId);
    expect(retriedRun.verdict).toBe("passed");
    expect(retriedRun.workDir).toBe(originalWorkDir);
    expect(retriedRun.branch).toBe(originalBranch);
    expect(retriedRun.executionSessionId).toBe(originalExecutionSessionId);
  }, 20_000);

  it("uses a valid placeholder when compensation lacks a question", async () => {
    const { provideInputCore } = await import("./tickets.server");
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Original question?",
    });
    const ticketId = await insertApproved(19);
    const { runId } = await dispatchRun(ticketId, "execute");
    await waitForRun(runId, "awaiting_input");
    await runs.updateOne(
      { _id: new ObjectId(runId) },
      { $set: { awaitingQuestion: null } },
    );

    await rm(join(binDirectory, "claude"), { force: true });
    process.env.PATH = binDirectory;
    await expect(
      provideInputCore({ ticketId, answer: "record this" }),
    ).rejects.toThrow();

    const run = await runs.findOne({ _id: new ObjectId(runId) });
    expect(run?.status).toBe("awaiting_input");
    expect(run?.exchanges.at(-1)).toMatchObject({
      question: "(question unavailable)",
      answer: null,
      answeredAt: null,
    });
    expect(() => InputExchangeSchema.parse(run?.exchanges.at(-1))).not.toThrow();
  }, 20_000);

  it("caps exchange history when a failed resume reopens the question", async () => {
    const { provideInputCore } = await import("./tickets.server");
    process.env.T4D_OUTCOME = JSON.stringify({
      outcome: "needs_input",
      question: "Retry question?",
    });
    const ticketId = await insertApproved(14);
    const { runId } = await dispatchRun(ticketId, "execute");
    const parkedRun = await waitForRun(runId, "awaiting_input");
    const historyAt = timestamp();
    const history: Run["exchanges"] = Array.from(
      { length: 49 },
      (_, index) => ({
        v: 1,
        at: historyAt,
        question: `History ${index}`,
        handoff: null,
        answer: `Answer ${index}`,
        answeredAt: historyAt,
      }),
    );
    await runs.updateOne(
      { _id: new ObjectId(runId) },
      { $set: { exchanges: [...history, parkedRun.exchanges[0]!] } },
    );

    await rm(join(binDirectory, "claude"), { force: true });
    process.env.PATH = binDirectory;
    await expect(
      provideInputCore({ ticketId, answer: "retry answer" }),
    ).rejects.toThrow();

    const run = await runs.findOne({ _id: new ObjectId(runId) });
    expect(run?.exchanges).toHaveLength(50);
    expect(run?.exchanges[0]?.question).toBe("History 1");
    expect(run?.exchanges.at(-2)).toMatchObject({
      question: "Retry question?",
      answer: "retry answer",
    });
    expect(run?.exchanges.at(-1)).toMatchObject({
      question: "Retry question?",
      answer: null,
      answeredAt: null,
    });
  }, 20_000);

  it("sends a completed outcome through verification", async () => {
    process.env.T4D_OUTCOME = JSON.stringify({ outcome: "completed" });
    const ticketId = await insertApproved(4);
    const { runId } = await dispatchRun(ticketId, "execute");

    const run = await waitForRun(runId, "succeeded");
    const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });

    expect(ticket?.status).toBe("review_ready");
    expect(run.verdict).toBe("passed");
  }, 20_000);

  it("blocks a missing outcome as runner_reported_failure", async () => {
    const ticketId = await insertApproved(5);
    const { runId } = await dispatchRun(ticketId, "execute");

    const run = await waitForRun(runId, "failed");
    const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });

    expect(ticket?.status).toBe("blocked");
    expect(run.failureKind).toBe("runner_reported_failure");
  }, 20_000);
});
