import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Collection, Db, WithId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Board, Run, Ticket } from "../domain/schemas";

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
const { dispatchRun } = await import("./supervisor.server");

let database: Db;
let boards: Collection<BoardDoc>;
let tickets: Collection<TicketDoc>;
let runs: Collection<RunDoc>;
let repo: string;
let binDirectory: string;
let boardId: string;

const timestamp = () => new Date().toISOString();

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
