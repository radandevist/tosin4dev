import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Collection, Db } from "mongodb";
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

const TEST_DB = `tosin4dev-test-supervisor-${process.pid}-${Date.now()}`;
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;
process.env.DISCORD_WEBHOOK_URL = "";

const { db, closeDb, ObjectId } = await import("./db");
const { dispatchRun, recoverOrphans } = await import("./supervisor.server");

let database: Db;
let boards: Collection<BoardDoc>;
let tickets: Collection<TicketDoc>;
let runs: Collection<RunDoc>;
let repo: string;
let binDirectory: string;
let boardId: string;

const timestamp = () => new Date().toISOString();
type BootGlobal = typeof globalThis & { __tosin4devRecovered?: Promise<void> };

async function seedOrphan(
  seq: number,
  status: "running" | "verifying",
): Promise<{ ticketId: string; runId: import("mongodb").ObjectId }> {
  const ticketId = await insertTicket("running", seq);
  const runId = new ObjectId();
  const at = timestamp();
  await tickets.updateOne(
    { _id: new ObjectId(ticketId) },
    { $set: { activeRunId: runId.toString() } },
  );
  await runs.insertOne({
    _id: runId,
    ticketId,
    boardId,
    runner: "claude",
    phase: "execute",
    status,
    workDir: repo,
    promptFile: join(repo, `p-${seq}.md`),
    logFile: join(repo, `o-${seq}.log`),
    pid: 2_147_483_647,
    exitCode: null,
    summary: null,
    branch: null,
    baseSha: null,
    verdict: null,
    failureKind: null,
    queuedAt: at,
    startedAt: at,
    finishedAt: null,
  });
  return { ticketId, runId };
}

async function writeRunner(
  lines: readonly string[],
  exitCode = 0,
  commit = false,
): Promise<void> {
  const body = lines.map((line) => `printf '%s\\n' '${line}'`).join("\n");
  const commitBody = commit
    ? `echo "artifact $$" > verify-artifact.txt\ngit add -A\ngit commit -m "runner work" >/dev/null 2>&1\n`
    : "";
  const executable = join(binDirectory, "claude");
  await writeFile(executable, `#!/bin/sh\n${body}\n${commitBody}exit ${exitCode}\n`);
  await chmod(executable, 0o755);
}

async function insertTicket(
  status: Ticket["status"],
  seq: number,
  activeRunId: string | null = null,
): Promise<string> {
  const at = timestamp();
  const result = await tickets.insertOne({
    boardId,
    seq,
    title: `smoke ${seq}`,
    type: "implement",
    status,
    runner: "claude",
    spec: {
      intent: "exercise the supervisor",
      scope: "README.md",
      nonGoals: "none",
      acceptance: ["runner exits"],
      links: [],
      risk: "low",
      approvedAt: status === "approved" ? at : null,
      approvedBy: status === "approved" ? "radan" : null,
    },
    activeRunId,
    prUrl: null,
    activity: [],
    createdAt: at,
    updatedAt: at,
  });
  return result.insertedId.toString();
}

async function waitForRun(
  runId: string,
  expected: Run["status"],
  timeoutMs = 10_000,
): Promise<RunDoc> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await runs.findOne({ _id: new ObjectId(runId) });
    if (run?.status === expected) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} did not reach ${expected}`);
}

describe("supervisor smoke", () => {
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "t4d-repo-"));
    binDirectory = await mkdtemp(join(tmpdir(), "t4d-bin-"));
    execFileSync("git", ["init", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t4d@example.test"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Tosin4dev Test"]);
    await writeFile(join(repo, "README.md"), "smoke\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);
    await writeRunner(["runner output", "## SUMMARY", "smoke ok"]);
    process.env.PATH = `${binDirectory}:${ORIGINAL_PATH ?? ""}`;

    database = await db();
    boards = database.collection<BoardDoc>("boards");
    tickets = database.collection<TicketDoc>("tickets");
    runs = database.collection<RunDoc>("runs");
    const at = timestamp();
    const board = await boards.insertOne({
      slug: `smoke-${process.pid}-${Date.now()}`,
      name: "Supervisor Smoke",
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
    await tickets.deleteMany({ boardId });
    await runs.deleteMany({ boardId });
    await writeRunner(["runner output", "## SUMMARY", "smoke ok"]);
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

  it("executes end-to-end on a named run branch", async () => {
    await writeRunner(["runner output", "## SUMMARY", "smoke ok"], 0, true);
    const ticketId = await insertTicket("approved", 1);
    const { runId } = await dispatchRun(ticketId, "execute");
    const run = await waitForRun(runId, "succeeded");
    const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });

    expect(ticket?.status).toBe("review_ready");
    expect(run.verdict).toBe("passed");
    expect(ticket?.activeRunId).toBeNull();
    expect(run.pid).toBeGreaterThan(0);
    expect(run.startedAt).toMatch(/Z$/);
    expect(run.finishedAt).toMatch(/Z$/);
    expect(run.exitCode).toBe(0);
    expect(run.summary).toBe("smoke ok");
    await expect(stat(run.workDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(readFile(run.promptFile, "utf8")).resolves.toContain("isolated git worktree");
    await expect(readFile(run.logFile, "utf8")).resolves.toContain("runner output");
  });

  it("runs spec drafting read-only in the repo without changing inbox status", async () => {
    const ticketId = await insertTicket("inbox", 2);
    const { runId } = await dispatchRun(ticketId, "spec_draft");
    const run = await waitForRun(runId, "succeeded");
    const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });

    expect(run.workDir).toBe(repo);
    expect(ticket?.status).toBe("inbox");
    expect(ticket?.activeRunId).toBeNull();
    await expect(readFile(run.promptFile, "utf8")).resolves.toContain("READ-ONLY");
  });

  it("keeps an inbox ticket unchanged when spec drafting fails", async () => {
    await writeRunner(["draft failed", "SUMMARY", "draft failure"], 9);
    const ticketId = await insertTicket("inbox", 8);
    const { runId } = await dispatchRun(ticketId, "spec_draft");
    const run = await waitForRun(runId, "failed");
    const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });

    expect(run.exitCode).toBe(9);
    expect(ticket?.status).toBe("inbox");
    expect(ticket?.activeRunId).toBeNull();
  });

  it("accepts review fixes only from the already-running state", async () => {
    const ticketId = await insertTicket("running", 9);
    await writeRunner(["runner output", "## SUMMARY", "smoke ok"], 0, true);
    const { runId } = await dispatchRun(ticketId, "review_fix");
    await waitForRun(runId, "succeeded");
    const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
    expect(ticket?.status).toBe("review_ready");

    const approvedTicketId = await insertTicket("approved", 10);
    await expect(dispatchRun(approvedTicketId, "review_fix")).rejects.toThrow(
      /running ticket/i,
    );
  });

  it("records a failed runner and blocks an execute ticket", async () => {
    await writeRunner(["runner failed", "SUMMARY", "failure details"], 7);
    const ticketId = await insertTicket("approved", 3);
    const { runId } = await dispatchRun(ticketId, "execute");
    const run = await waitForRun(runId, "failed");
    const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });

    expect(run.exitCode).toBe(7);
    expect(ticket?.status).toBe("blocked");
    expect(ticket?.activeRunId).toBeNull();
  });

  it("rejects a duplicate active-run claim", async () => {
    const claimedTicketId = await insertTicket(
      "approved",
      4,
      "0123456789abcdef01234567",
    );
    await expect(dispatchRun(claimedTicketId, "execute")).rejects.toThrow(/active run/i);
  });

  it("rolls back the ticket and records failure when spawn setup fails", async () => {
    const spawnFailureTicketId = await insertTicket("inbox", 5);
    process.env.PATH = binDirectory;
    await rm(join(binDirectory, "claude"), { force: true });
    await expect(dispatchRun(spawnFailureTicketId, "spec_draft")).rejects.toThrow();
    const ticket = await tickets.findOne({ _id: new ObjectId(spawnFailureTicketId) });
    const failedRun = await runs.findOne({ ticketId: spawnFailureTicketId });
    expect(ticket?.status).toBe("inbox");
    expect(ticket?.activeRunId).toBeNull();
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.finishedAt).toMatch(/Z$/);
  });

  it("recovers a dead orphan without clearing another run's claim", async () => {
    const ticketId = await insertTicket("running", 6);
    const runId = new ObjectId();
    await tickets.updateOne(
      { _id: new ObjectId(ticketId) },
      { $set: { activeRunId: runId.toString() } },
    );
    const at = timestamp();
    await runs.insertOne({
      _id: runId,
      ticketId,
      boardId,
      runner: "claude",
      phase: "execute",
      status: "running",
      workDir: repo,
      promptFile: join(repo, "prompt.md"),
      logFile: join(repo, "output.log"),
      pid: 2_147_483_647,
      exitCode: null,
      summary: null,
      branch: null,
      baseSha: null,
      verdict: null,
      failureKind: null,
      queuedAt: at,
      startedAt: at,
      finishedAt: null,
    });

    await recoverOrphans();
    const recoveredRun = await runs.findOne({ _id: runId });
    const recoveredTicket = await tickets.findOne({ _id: new ObjectId(ticketId) });
    expect(recoveredRun?.status).toBe("failed");
    expect(recoveredTicket?.status).toBe("blocked");
    expect(recoveredTicket?.activeRunId).toBeNull();

    const unrelatedClaim = new ObjectId().toString();
    const unrelatedTicketId = await insertTicket("running", 7, unrelatedClaim);
    const unrelatedDeadRunId = new ObjectId();
    await runs.insertOne({
      _id: unrelatedDeadRunId,
      ticketId: unrelatedTicketId,
      boardId,
      runner: "claude",
      phase: "execute",
      status: "running",
      workDir: repo,
      promptFile: join(repo, "other-prompt.md"),
      logFile: join(repo, "other-output.log"),
      pid: 2_147_483_647,
      exitCode: null,
      summary: null,
      branch: null,
      baseSha: null,
      verdict: null,
      failureKind: null,
      queuedAt: at,
      startedAt: at,
      finishedAt: null,
    });
    await recoverOrphans();
    const unrelatedTicket = await tickets.findOne({ _id: new ObjectId(unrelatedTicketId) });
    expect(unrelatedTicket?.status).toBe("running");
    expect(unrelatedTicket?.activeRunId).toBe(unrelatedClaim);
    await expect(runs.findOne({ _id: unrelatedDeadRunId })).resolves.toMatchObject({
      status: "failed",
    });
  });

  it("recovers a dead run orphaned in the verifying state", async () => {
    (globalThis as BootGlobal).__tosin4devRecovered = undefined;
    const { ticketId, runId } = await seedOrphan(40, "verifying");
    await recoverOrphans();
    const run = await runs.findOne({ _id: runId });
    const ticket = await tickets.findOne({ _id: new ObjectId(ticketId) });
    expect(run?.status).toBe("failed");
    expect(run?.failureKind).toBe("verification_failed");
    expect(ticket?.status).toBe("blocked");
    expect(ticket?.activeRunId).toBeNull();
  });

  it("runs orphan recovery exactly once per process", async () => {
    (globalThis as BootGlobal).__tosin4devRecovered = undefined;
    const { bootRecoveryOnce } = await import("./supervisor.server");
    const first = await seedOrphan(41, "running");
    await bootRecoveryOnce();
    await bootRecoveryOnce();
    expect((await runs.findOne({ _id: first.runId }))?.status).toBe("failed");
    expect((await tickets.findOne({ _id: new ObjectId(first.ticketId) }))?.status).toBe("blocked");
    const later = await seedOrphan(42, "running");
    await bootRecoveryOnce();
    expect((await runs.findOne({ _id: later.runId }))?.status).toBe("running");
    (globalThis as BootGlobal).__tosin4devRecovered = undefined;
  });
});
