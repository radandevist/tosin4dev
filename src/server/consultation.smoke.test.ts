import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Db } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DB = `tosin4dev-test-consultation-${process.pid}-${Date.now()}`;
const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_TEST_TOKEN = process.env.T4D_TEST_TOKEN;
const ORIGINAL_CWD_CAPTURE = process.env.T4D_CONSULT_CWD_CAPTURE;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;

const execFileAsync = promisify(execFile);
const { db, closeDb, ObjectId } = await import("./db");
const {
  createConsultationSessionCore,
  getChatSessionCore,
  proposeBundleFromChatCore,
  sendChatMessageCore,
} = await import("./chat.server");

let database: Db;
let repoPath: string;
let binDir: string;
let baseSha: string;
let boardId: string;
let ticketId: string;

const at = (second: number) =>
  `2026-07-23T10:00:${String(second).padStart(2, "0")}.000Z`;

async function waitForSettled(sessionId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await getChatSessionCore({ sessionId });
    if (session.turnStatus !== "pending") return session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("consultation turn did not settle");
}

async function insertRun(
  status: "awaiting_input" | "running" = "awaiting_input",
  handoffSecret?: string,
): Promise<string> {
  const run = await database.collection("runs").insertOne({
    ticketId,
    boardId,
    runner: "claude",
    phase: "execute",
    status,
    workDir: join(repoPath, ".tosin4dev", "worktrees", "fixture"),
    promptFile: join(repoPath, ".tosin4dev", "runs", "fixture", "prompt.md"),
    logFile: join(repoPath, ".tosin4dev", "runs", "fixture", "output.log"),
    stderrFile: join(repoPath, ".tosin4dev", "runs", "fixture", "stderr.log"),
    exitCode: null,
    summary: null,
    branch: "tosin4dev/run/fixture",
    baseSha,
    verdict: null,
    failureKind: null,
    executionSessionId: null,
    awaitingQuestion: "Should we use signed cookies or server sessions?",
    exchanges: [
      {
        v: 1,
        at: at(2),
        question: "Should we use signed cookies or server sessions?",
        handoff: handoffSecret
          ? {
              workDone: `Inspected authentication with ${handoffSecret}`,
              filesTouched: [],
              commandsRun: [],
              decision: "Choose the session strategy",
              options: ["Signed cookies", "Server sessions"],
              risk: "",
            }
          : null,
        answer: null,
        answeredAt: null,
      },
    ],
    pid: null,
    queuedAt: at(0),
    startedAt: at(1),
    finishedAt: null,
  });
  return run.insertedId.toString();
}

beforeAll(async () => {
  repoPath = await mkdtemp(join(tmpdir(), "t4d-consult-repo-"));
  binDir = await mkdtemp(join(tmpdir(), "t4d-consult-bin-"));
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Consultation Test"], {
    cwd: repoPath,
  });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: repoPath,
  });
  await writeFile(join(repoPath, "fixture.txt"), "base\n");
  await execFileAsync("git", ["add", "fixture.txt"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd: repoPath });
  const revision = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repoPath,
    encoding: "utf8",
  });
  baseSha = revision.stdout.trim();

  const fakeClaude = join(binDir, "claude");
  await writeFile(
    fakeClaude,
    `#!/bin/sh
pwd > "$T4D_CONSULT_CWD_CAPTURE"
printf '%s\\n' '{"type":"result","session_id":"consult-session","result":"advice only"}'
`,
  );
  await chmod(fakeClaude, 0o755);
  process.env.PATH = `${binDir}:${ORIGINAL_PATH ?? ""}`;
  database = await db();
});

beforeEach(async () => {
  await Promise.all([
    database.collection("boards").deleteMany({}),
    database.collection("tickets").deleteMany({}),
    database.collection("runs").deleteMany({}),
    database.collection("chatSessions").deleteMany({}),
    database.collection("specBundles").deleteMany({}),
  ]);
  process.env.T4D_TEST_TOKEN = ORIGINAL_TEST_TOKEN;

  const created = at(0);
  const board = await database.collection("boards").insertOne({
    slug: `consult-${new ObjectId().toString()}`,
    name: "Consultation",
    repoPath,
    defaultBaseBranch: "main",
    checks: [],
    createdAt: created,
    updatedAt: created,
  });
  boardId = board.insertedId.toString();
  const ticket = await database.collection("tickets").insertOne({
    boardId,
    seq: 10,
    title: "Choose authentication storage",
    type: "implement",
    status: "needs_input",
    runner: "claude",
    spec: {
      intent: "Select a secure authentication storage strategy",
      scope: "Server-side authentication state",
      nonGoals: "No login UI changes",
      acceptance: ["The storage choice is documented"],
      links: [],
      risk: "medium",
      approvedAt: created,
      approvedBy: "radan",
    },
    activeRunId: null,
    prUrl: null,
    activity: [],
    dependsOn: [],
    createdAt: created,
    updatedAt: created,
  });
  ticketId = ticket.insertedId.toString();
});

afterAll(async () => {
  await database?.dropDatabase();
  await closeDb();
  process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;
  process.env.PATH = ORIGINAL_PATH;
  process.env.T4D_TEST_TOKEN = ORIGINAL_TEST_TOKEN;
  process.env.T4D_CONSULT_CWD_CAPTURE = ORIGINAL_CWD_CAPTURE;
  await Promise.all([
    rm(repoPath, { recursive: true, force: true }),
    rm(binDir, { recursive: true, force: true }),
  ]);
});

describe("consultation sessions", () => {
  it("seeds an awaiting run with its intent and open question", async () => {
    const runId = await insertRun();
    const { id } = await createConsultationSessionCore({ runId });
    const session = await getChatSessionCore({ sessionId: id });

    expect(session).toMatchObject({
      kind: "consultation",
      runId,
      provider: "claude",
      status: "active",
    });
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toMatchObject({ role: "user" });
    expect(session.messages[0].text).toContain(
      "Select a secure authentication storage strategy",
    );
    expect(session.messages[0].text).toContain(
      "Should we use signed cookies or server sessions?",
    );
  });

  it("rejects a run that is not awaiting input", async () => {
    const runId = await insertRun("running");

    await expect(
      createConsultationSessionCore({ runId }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "run is not awaiting input",
    });
  });

  it("redacts secrets from handoff fields in the seeded message", async () => {
    const secret = "consultation-secret-1234";
    process.env.T4D_TEST_TOKEN = secret;
    const runId = await insertRun("awaiting_input", secret);

    const { id } = await createConsultationSessionCore({ runId });
    const session = await getChatSessionCore({ sessionId: id });

    expect(session.messages[0].text).not.toContain(secret);
    expect(session.messages[0].text).toContain("[REDACTED]");
  });

  it("spawns in an empty run scratch directory, never the board repo", async () => {
    const runId = await insertRun();
    const captureFile = join(repoPath, `consult-cwd-${runId}.txt`);
    process.env.T4D_CONSULT_CWD_CAPTURE = captureFile;
    const { id } = await createConsultationSessionCore({ runId });
    const scratchDir = join(repoPath, ".tosin4dev", "runs", runId, "consult");

    await sendChatMessageCore({ sessionId: id, text: "Help me decide" });
    const session = await waitForSettled(id);

    expect(session.turnStatus).toBe("idle");
    expect((await readFile(captureFile, "utf8")).trim()).toBe(scratchDir);
    expect(scratchDir).not.toBe(repoPath);
    expect(await readdir(scratchDir)).toEqual([]);
  });

  it("cannot propose a bundle or mutate tickets", async () => {
    const runId = await insertRun();
    const { id } = await createConsultationSessionCore({ runId });
    const ticketBefore = await database
      .collection("tickets")
      .findOne({ _id: new ObjectId(ticketId) });

    await expect(
      proposeBundleFromChatCore({ sessionId: id }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "consultation sessions cannot propose bundles",
    });

    expect(await database.collection("specBundles").countDocuments()).toBe(0);
    expect(
      await database
        .collection("tickets")
        .findOne({ _id: new ObjectId(ticketId) }),
    ).toEqual(ticketBefore);
  });

  it("hydrates genuinely legacy sessions with absent kind and runId keys", async () => {
    const legacyId = new ObjectId();
    const currentId = new ObjectId();
    const base = {
      boardId,
      provider: "claude",
      sessionId: null,
      status: "active",
      turnStatus: "idle",
      turnError: null,
      messages: [],
      bundleId: null,
      createdAt: at(0),
      updatedAt: at(0),
      pid: null,
      logFile: null,
      pendingKind: null,
      pendingUserMessageAt: null,
    };
    await database.collection("chatSessions").insertMany([
      { _id: legacyId, ...base },
      { _id: currentId, ...base, kind: "brainstorm", runId: null },
    ]);

    const [legacy, current] = await Promise.all([
      getChatSessionCore({ sessionId: legacyId.toString() }),
      getChatSessionCore({ sessionId: currentId.toString() }),
    ]);

    expect(legacy).toMatchObject({ kind: "brainstorm", runId: null });
    expect(current).toMatchObject({ kind: "brainstorm", runId: null });
  });
});
