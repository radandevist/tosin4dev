import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Db } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DB = `tosin4dev-test-forkconsult-${process.pid}-${Date.now()}`;
const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_TEST_TOKEN = process.env.T4D_TEST_TOKEN;
const ORIGINAL_PROMPT_CAPTURE = process.env.T4D_CONSULT_PROMPT_CAPTURE;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;

const execFileAsync = promisify(execFile);
const { db, closeDb, ObjectId } = await import("./db");
const {
  createConsultationSessionCore,
  forkConsultationSessionCore,
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
let promptCaptureFile: string;

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

async function insertRun(): Promise<string> {
  const run = await database.collection("runs").insertOne({
    ticketId,
    boardId,
    runner: "claude",
    phase: "execute",
    status: "awaiting_input",
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
    exchanges: [],
    pid: null,
    queuedAt: at(0),
    startedAt: at(1),
    finishedAt: null,
  });
  return run.insertedId.toString();
}

beforeAll(async () => {
  repoPath = await mkdtemp(join(tmpdir(), "t4d-forkconsult-repo-"));
  binDir = await mkdtemp(join(tmpdir(), "t4d-forkconsult-bin-"));
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Fork Test"], {
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
# args: -p <text> --output-format json [--resume <sid>]
case "$2" in
  *"hold"*) sleep 1 ;;
esac
printf '%s\\n' "$2" > "$T4D_CONSULT_PROMPT_CAPTURE"
printf '%s\\n' '{"type":"result","session_id":"consult-session","result":"advice only"}'
`,
  );
  await chmod(fakeClaude, 0o755);
  process.env.PATH = `${binDir}:${ORIGINAL_PATH ?? ""}`;
  database = await db();
  promptCaptureFile = join(repoPath, "last-prompt.txt");
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
  process.env.T4D_CONSULT_PROMPT_CAPTURE = promptCaptureFile;

  const created = at(0);
  const board = await database.collection("boards").insertOne({
    slug: `fork-${new ObjectId().toString()}`,
    name: "Fork",
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
  process.env.T4D_CONSULT_PROMPT_CAPTURE = ORIGINAL_PROMPT_CAPTURE;
  await Promise.all([
    rm(repoPath, { recursive: true, force: true }),
    rm(binDir, { recursive: true, force: true }),
  ]);
});

async function readPrompt(): Promise<string> {
  return (await readFile(promptCaptureFile, "utf8")).trim();
}

describe("forked consultation sessions", () => {
  async function buildTranscript() {
    const runId = await insertRun();
    const { id } = await createConsultationSessionCore({ runId });
    await sendChatMessageCore({ sessionId: id, text: "first question" });
    await waitForSettled(id);
    await sendChatMessageCore({ sessionId: id, text: "second question" });
    await waitForSettled(id);
    return { runId, id };
  }

  it("copies the transcript prefix and leaves the source session untouched", async () => {
    const { id } = await buildTranscript();
    const sourceBefore = await getChatSessionCore({ sessionId: id });

    const { id: forkId } = await forkConsultationSessionCore({ sessionId: id });
    const fork = await getChatSessionCore({ sessionId: forkId });
    const sourceAfter = await getChatSessionCore({ sessionId: id });

    expect(fork.messages).toEqual(sourceBefore.messages);
    expect(sourceAfter).toEqual(sourceBefore);
    expect(fork._id).not.toBe(id);
  });

  it("sets sessionId: null on the fork even when the source had a captured provider session", async () => {
    const { id } = await buildTranscript();
    const source = await getChatSessionCore({ sessionId: id });
    expect(source.sessionId).toBe("consult-session");

    const { id: forkId } = await forkConsultationSessionCore({ sessionId: id });
    const fork = await getChatSessionCore({ sessionId: forkId });
    expect(fork.sessionId).toBeNull();
  });

  it("records forkedFromSessionId and forkedAtMessageCount", async () => {
    const { id } = await buildTranscript();
    const source = await getChatSessionCore({ sessionId: id });

    const { id: forkId } = await forkConsultationSessionCore({ sessionId: id });
    const fork = await getChatSessionCore({ sessionId: forkId });

    expect(fork.forkedFromSessionId).toBe(source._id);
    expect(fork.forkedAtMessageCount).toBe(source.messages.length);
  });

  it("truncates via throughMessageCount and clamps out-of-range values", async () => {
    const { id } = await buildTranscript();
    const source = await getChatSessionCore({ sessionId: id });
    const length = source.messages.length;

    const truncated = await forkConsultationSessionCore({
      sessionId: id,
      throughMessageCount: 2,
    });
    const truncatedSession = await getChatSessionCore({
      sessionId: truncated.id,
    });
    expect(truncatedSession.messages).toEqual(source.messages.slice(0, 2));
    expect(truncatedSession.forkedAtMessageCount).toBe(2);

    const clampedUp = await forkConsultationSessionCore({
      sessionId: id,
      throughMessageCount: 0,
    });
    const clampedUpSession = await getChatSessionCore({
      sessionId: clampedUp.id,
    });
    expect(clampedUpSession.messages).toEqual(source.messages.slice(0, 1));
    expect(clampedUpSession.forkedAtMessageCount).toBe(1);

    const clampedDown = await forkConsultationSessionCore({
      sessionId: id,
      throughMessageCount: 999,
    });
    const clampedDownSession = await getChatSessionCore({
      sessionId: clampedDown.id,
    });
    expect(clampedDownSession.messages).toEqual(source.messages);
    expect(clampedDownSession.forkedAtMessageCount).toBe(length);
  });

  it("rejects forking a brainstorm session", async () => {
    const runId = await insertRun();
    const { id } = await createConsultationSessionCore({ runId });
    const coll = await database.collection("chatSessions");
    await coll.updateOne(
      { _id: new ObjectId(id) },
      { $set: { kind: "brainstorm" } },
    );

    await expect(
      forkConsultationSessionCore({ sessionId: id }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "only consultation sessions can be forked",
    });
  });

  it("rejects forking while turnStatus is pending", async () => {
    const runId = await insertRun();
    const { id } = await createConsultationSessionCore({ runId });
    await sendChatMessageCore({ sessionId: id, text: "hold" });

    await expect(
      forkConsultationSessionCore({ sessionId: id }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "cannot fork a consultation while a turn is in progress",
    });

    await waitForSettled(id);
  });

  it("returns not_found for an unknown session id", async () => {
    await expect(
      forkConsultationSessionCore({ sessionId: new ObjectId().toString() }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("chat session not found"),
    });
  });

  it("a forked session still cannot propose a bundle", async () => {
    const { id } = await buildTranscript();
    const { id: forkId } = await forkConsultationSessionCore({ sessionId: id });

    await expect(
      proposeBundleFromChatCore({ sessionId: forkId }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "consultation sessions cannot propose bundles",
    });

    expect(await database.collection("specBundles").countDocuments()).toBe(0);
  });

  it("flattens every carried message into the re-seed, and a single-message consultation is unchanged", async () => {
    const runId = await insertRun();
    const { id } = await createConsultationSessionCore({ runId });
    await sendChatMessageCore({ sessionId: id, text: "question one" });
    await waitForSettled(id);
    await sendChatMessageCore({ sessionId: id, text: "question two" });
    await waitForSettled(id);
    const source = await getChatSessionCore({ sessionId: id });

    const { id: forkId } = await forkConsultationSessionCore({
      sessionId: id,
      throughMessageCount: 3,
    });
    await sendChatMessageCore({ sessionId: forkId, text: "the branch" });
    await waitForSettled(forkId);
    const prompt = await readPrompt();

    expect(prompt).toContain(source.messages[0].text);
    expect(prompt).toContain(`User:\n${source.messages[1].text}`);
    expect(prompt).toContain(`Assistant:\n${source.messages[2].text}`);
    expect(prompt.endsWith("the branch")).toBe(true);

    const { id: freshId } = await createConsultationSessionCore({ runId });
    await sendChatMessageCore({ sessionId: freshId, text: "help me" });
    await waitForSettled(freshId);
    const fresh = await getChatSessionCore({ sessionId: freshId });
    const freshPrompt = await readPrompt();
    expect(freshPrompt).toBe(
      `${fresh.messages[0].text}\n\nhelp me`,
    );
  });
});