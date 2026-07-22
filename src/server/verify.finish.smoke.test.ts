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
    `#!/bin/sh\nprintf '%s\\n' 'out'\nprintf '%s\\n' '## SUMMARY'\nprintf '%s\\n' 'ok'\n${commitBody}printf '%s' '{"outcome":"completed"}' > "$T4D_OUTCOME_PATH"\nexit ${exitCode}\n`,
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
    await Promise.all([rm(repo, { recursive: true, force: true }), rm(binDirectory, { recursive: true, force: true })]);
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
