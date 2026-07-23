import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Collection, Db, WithId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Board, Run, Ticket } from "../domain/schemas";

type BoardDoc = Board & { createdAt: string; updatedAt: string };
type TicketDoc = Ticket & { createdAt: string; updatedAt: string };
type RunDoc = Run & {
  stderrFile?: string | null;
  pid: number | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

const TEST_DB = `tosin4dev-test-log-split-${process.pid}-${Date.now()}`;
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;
process.env.DISCORD_WEBHOOK_URL = "";

const { db, closeDb, ObjectId } = await import("./db");
const { logTailCore } = await import("./runs.server");
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
printf '%s\\n' 'stdout-only-content'
printf '%s\\n' 'stderr-only-content' >&2
exit 0
`,
  );
  await chmod(executable, 0o755);
}

async function insertInboxTicket(): Promise<string> {
  const at = timestamp();
  const result = await tickets.insertOne({
    boardId,
    seq: 1,
    title: "split runner streams",
    type: "implement",
    status: "inbox",
    runner: "claude",
    spec: {
      intent: "exercise split run logs",
      scope: "",
      nonGoals: "",
      acceptance: [],
      links: [],
      risk: "low",
      approvedAt: null,
      approvedBy: null,
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
  timeoutMs = 10_000,
): Promise<WithId<RunDoc>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await runs.findOne({ _id: new ObjectId(runId) });
    if (run?.status === expected) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} did not reach ${expected}`);
}

describe("split run logs", () => {
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "t4d-log-split-repo-"));
    binDirectory = await mkdtemp(join(tmpdir(), "t4d-log-split-bin-"));
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
      slug: `log-split-${process.pid}-${Date.now()}`,
      name: "Log Split",
      repoPath: repo,
      defaultBaseBranch: "main",
      checks: [],
      createdAt: at,
      updatedAt: at,
    });
    boardId = board.insertedId.toString();
  });

  beforeEach(async () => {
    process.env.PATH = `${binDirectory}:${ORIGINAL_PATH ?? ""}`;
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
    await Promise.all([
      rm(repo, { recursive: true, force: true }),
      rm(binDirectory, { recursive: true, force: true }),
    ]);
  });

  it("stores and tails stdout and stderr separately", async () => {
    const ticketId = await insertInboxTicket();
    const { runId } = await dispatchRun(ticketId, "spec_draft");
    const run = await waitForRun(runId, "succeeded");

    expect(run.stderrFile).toEqual(expect.any(String));
    if (!run.stderrFile) throw new Error("run has no stderr file");
    const [stdout, stderr] = await Promise.all([
      readFile(run.logFile, "utf8"),
      readFile(run.stderrFile, "utf8"),
    ]);

    expect(stdout).toContain("stdout-only-content");
    expect(stdout).not.toContain("stderr-only-content");
    expect(stderr).toContain("stderr-only-content");
    expect(stderr).not.toContain("stdout-only-content");

    const tail = await logTailCore({ runId, bytes: 20_000 });
    expect(tail.text).toContain("stdout-only-content");
    expect(tail.text).toContain("──── stderr ────");
    expect(tail.text).toContain("stderr-only-content");
  });

  it("tails a legacy run without adding a stderr delimiter", async () => {
    const at = timestamp();
    const logFile = join(repo, "legacy-output.log");
    await writeFile(logFile, "legacy stdout content\n");
    const result = await runs.insertOne({
      ticketId: new ObjectId().toString(),
      boardId,
      runner: "claude",
      phase: "spec_draft",
      status: "succeeded",
      workDir: repo,
      promptFile: join(repo, "legacy-prompt.md"),
      logFile,
      stderrFile: null,
      pid: null,
      exitCode: 0,
      summary: null,
      branch: null,
      baseSha: null,
      verdict: null,
      failureKind: null,
      executionSessionId: null,
      awaitingQuestion: null,
      queuedAt: at,
      startedAt: at,
      finishedAt: at,
    });

    const tail = await logTailCore({
      runId: result.insertedId.toString(),
      bytes: 20_000,
    });
    expect(tail.text).toContain("legacy stdout content");
    expect(tail.text).not.toContain("──── stderr ────");
  });
});
