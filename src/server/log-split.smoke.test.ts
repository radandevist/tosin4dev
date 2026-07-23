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
const { listRunsCore, logTailCore } = await import("./runs.server");
const { dispatchRun } = await import("./supervisor.server");

let database: Db;
let boards: Collection<BoardDoc>;
let tickets: Collection<TicketDoc>;
let runs: Collection<RunDoc>;
let repo: string;
let binDirectory: string;
let boardId: string;

const timestamp = () => new Date().toISOString();

function runDocument(
  ticketId: string,
  logFile: string,
): Omit<RunDoc, "stderrFile"> {
  const at = timestamp();
  return {
    ticketId,
    boardId,
    runner: "claude",
    phase: "spec_draft",
    status: "succeeded",
    workDir: repo,
    promptFile: join(repo, "prompt.md"),
    logFile,
    pid: null,
    exitCode: 0,
    summary: null,
    branch: null,
    baseSha: null,
    verdict: null,
    failureKind: null,
    executionSessionId: null,
    awaitingQuestion: null,
    exchanges: [],
    queuedAt: at,
    startedAt: at,
    finishedAt: at,
  };
}

async function insertRunWithLogs(
  stdout: string,
  stderr: string,
): Promise<string> {
  const id = new ObjectId();
  const logFile = join(repo, `${id.toString()}-output.log`);
  const stderrFile = join(repo, `${id.toString()}-stderr.log`);
  await Promise.all([
    writeFile(logFile, stdout),
    writeFile(stderrFile, stderr),
  ]);
  await runs.insertOne({
    _id: id,
    ...runDocument(new ObjectId().toString(), logFile),
    stderrFile,
  });
  return id.toString();
}

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
    const logFile = join(repo, "legacy-output.log");
    await writeFile(logFile, "legacy stdout content\n");
    const result = await runs.insertOne({
      ...runDocument(new ObjectId().toString(), logFile),
      stderrFile: null,
    });

    const tail = await logTailCore({
      runId: result.insertedId.toString(),
      bytes: 20_000,
    });
    expect(tail.text).toContain("legacy stdout content");
    expect(tail.text).not.toContain("──── stderr ────");
  });

  it("lists and tails a legacy run with no stderrFile key", async () => {
    const ticketId = new ObjectId().toString();
    const logFile = join(repo, "key-absent-stderr-output.log");
    await writeFile(logFile, "key-absent legacy stdout\n");
    const result = await database
      .collection<Omit<RunDoc, "stderrFile">>("runs")
      .insertOne(runDocument(ticketId, logFile));

    const listed = await listRunsCore({ ticketId });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.stderrFile).toBeNull();

    const tail = await logTailCore({
      runId: result.insertedId.toString(),
      bytes: 20_000,
    });
    expect(tail.text).toBe("key-absent legacy stdout\n");
  });

  it("uses the full budget for stdout when stderr is empty", async () => {
    const runId = await insertRunWithLogs("s".repeat(50_000), "");

    const tail = await logTailCore({ runId, bytes: 20_000 });

    expect(Buffer.byteLength(tail.text, "utf8")).toBe(20_000);
    expect(tail.text).toBe("s".repeat(20_000));
  });

  it("charges both streams and the delimiter against the byte budget", async () => {
    const runId = await insertRunWithLogs(
      "s".repeat(50_000),
      "e".repeat(50_000),
    );

    const tail = await logTailCore({ runId, bytes: 20_000 });

    expect(Buffer.byteLength(tail.text, "utf8")).toBeLessThanOrEqual(20_000);
    expect(tail.text).toContain("──── stderr ────");
    expect(tail.text).toContain("s");
    expect(tail.text).toContain("e");
  });

  it("never exceeds the requested byte ceiling across small budgets", async () => {
    const runId = await insertRunWithLogs(
      "│─✓🚀 ".repeat(10_000),
      "│─✗⚠ ".repeat(10_000),
    );

    for (const bytes of [
      ...Array.from({ length: 70 }, (_, index) => index + 1),
      100,
      1_000,
      20_000,
    ]) {
      const { text } = await logTailCore({ runId, bytes });
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(bytes);
    }
  });

  it("handles a one-byte budget when stderr is non-empty", async () => {
    const runId = await insertRunWithLogs(
      "s".repeat(50_000),
      "e".repeat(50_000),
    );

    await expect(logTailCore({ runId, bytes: 1 })).resolves.toEqual({
      text: "s",
    });
  });
});
