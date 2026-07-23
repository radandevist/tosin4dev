import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Db } from "mongodb";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const TEST_DB = `tosin4dev-test-run-context-${process.pid}-${Date.now()}`;
const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_TEST_TOKEN = process.env.T4D_TEST_TOKEN;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;

const guardedAccess = vi.hoisted(() => ({
  paths: new Set<string>(),
  attempted: [] as string[],
  execFileCalls: [] as Array<{
    file: string;
    args: readonly string[];
    options: Record<string, unknown>;
  }>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const guard = (path: unknown) => {
    const value = String(path);
    if (guardedAccess.paths.has(value)) {
      guardedAccess.attempted.push(value);
      throw new Error(`forbidden log read: ${value}`);
    }
  };
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      guard(args[0]);
      return actual.open(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      guard(args[0]);
      return actual.readFile(...args);
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const mockedExecFile = vi.fn(actual.execFile);
  const customPromisify = Symbol.for("nodejs.util.promisify.custom");
  const actualPromisified = Object.getOwnPropertyDescriptor(
    actual.execFile,
    customPromisify,
  )?.value;
  Object.defineProperty(mockedExecFile, customPromisify, {
    value: (
      file: string,
      args: readonly string[],
      options: Record<string, unknown>,
    ) => {
      guardedAccess.execFileCalls.push({ file, args, options });
      return actualPromisified(file, args, options);
    },
  });
  return { ...actual, execFile: mockedExecFile };
});

const execFileAsync = promisify(execFile);
const { db, closeDb, ObjectId } = await import("./db");
const { buildRunContext, RUN_CONTEXT_CHAR_BUDGET } =
  await import("./runContext.server");
const { projectExchanges } = await import("./runExchanges");

let database: Db;
const tempDirs: string[] = [];

const at = (second: number) =>
  `2026-07-23T10:00:${String(second).padStart(2, "0")}.000Z`;

async function makeRepo(): Promise<{ workDir: string; baseSha: string }> {
  const workDir = await mkdtemp(join(tmpdir(), "tosin4dev-run-context-"));
  tempDirs.push(workDir);
  await execFileAsync("git", ["init", "-q"], { cwd: workDir });
  await execFileAsync("git", ["config", "user.name", "Run Context Test"], {
    cwd: workDir,
  });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: workDir,
  });
  await writeFile(join(workDir, "fixture.txt"), "base\n");
  await execFileAsync("git", ["add", "fixture.txt"], { cwd: workDir });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd: workDir });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: workDir,
    encoding: "utf8",
  });
  return { workDir, baseSha: stdout.trim() };
}

async function insertFixture(options?: {
  exchanges?: unknown;
  workDir?: string;
  baseSha?: string | null;
  branch?: string | null;
  logFile?: string;
  stderrFile?: string | null;
}): Promise<{ runId: string; workDir: string; baseSha: string }> {
  const repo =
    options?.workDir === undefined || options.baseSha === undefined
      ? await makeRepo()
      : { workDir: options.workDir, baseSha: options.baseSha ?? "" };
  const boardId = new ObjectId().toString();
  const ticket = await database.collection("tickets").insertOne({
    boardId,
    seq: 9,
    title: "Consult on authentication",
    type: "implement",
    status: "needs_input",
    runner: "codex",
    spec: {
      intent: "Choose a safe authentication design",
      scope: "Server authentication only",
      nonGoals: "No UI redesign",
      acceptance: ["Authentication decision is documented", "Tests pass"],
      links: [],
      risk: "medium",
      approvedAt: at(0),
      approvedBy: "radan",
    },
    activeRunId: null,
    prUrl: null,
    activity: [],
    dependsOn: [],
    createdAt: at(0),
    updatedAt: at(0),
  });
  const result = await database.collection("runs").insertOne({
    ticketId: ticket.insertedId.toString(),
    boardId,
    runner: "codex",
    phase: "execute",
    status: "awaiting_input",
    workDir: repo.workDir,
    promptFile: join(repo.workDir, "prompt.md"),
    logFile: options?.logFile ?? join(repo.workDir, "output.log"),
    stderrFile: options?.stderrFile ?? join(repo.workDir, "stderr.log"),
    exitCode: null,
    summary: null,
    branch: options?.branch ?? "feat/context-fixture",
    baseSha: options?.baseSha === undefined ? repo.baseSha : options.baseSha,
    verdict: null,
    failureKind: null,
    executionSessionId: null,
    awaitingQuestion: "Which authentication approach should we use?",
    exchanges: options?.exchanges ?? [],
    pid: null,
    queuedAt: at(0),
    startedAt: at(1),
    finishedAt: null,
  });
  return {
    runId: result.insertedId.toString(),
    workDir: repo.workDir,
    baseSha: repo.baseSha,
  };
}

beforeAll(async () => {
  database = await db();
});

beforeEach(async () => {
  guardedAccess.paths.clear();
  guardedAccess.attempted.length = 0;
  guardedAccess.execFileCalls.length = 0;
  await Promise.all([
    database.collection("runs").deleteMany({}),
    database.collection("tickets").deleteMany({}),
  ]);
});

afterEach(async () => {
  process.env.T4D_TEST_TOKEN = ORIGINAL_TEST_TOKEN;
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

afterAll(async () => {
  await database?.dropDatabase();
  await closeDb();
  process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;
  process.env.T4D_TEST_TOKEN = ORIGINAL_TEST_TOKEN;
});

describe("buildRunContext", () => {
  it("always includes the locked ticket title, intent, and acceptance", async () => {
    const { runId } = await insertFixture();

    const { text } = await buildRunContext(runId);

    expect(text).toContain("Consult on authentication");
    expect(text).toContain("Choose a safe authentication design");
    expect(text).toContain("Authentication decision is documented");
    expect(text).toContain("Tests pass");
  });

  it("includes a denormalized open question and every valid answered exchange, newest first", async () => {
    const exchanges = [
      {
        v: 1,
        at: at(2),
        question: "Old answered question",
        handoff: null,
        answer: "Old answer",
        answeredAt: at(3),
      },
      {
        v: 1,
        at: at(4),
        question: "New answered question",
        handoff: null,
        answer: "New answer",
        answeredAt: at(5),
      },
    ];
    const { runId } = await insertFixture({ exchanges });

    const { text } = await buildRunContext(runId);

    expect(text).toContain("Which authentication approach should we use?");
    expect(text).toContain("Old answered question");
    expect(text).toContain("Old answer");
    expect(text).toContain("New answered question");
    expect(text).toContain("New answer");
    expect(
      text.indexOf("Which authentication approach should we use?"),
    ).toBeLessThan(text.indexOf("New answered question"));
    expect(text.indexOf("New answered question")).toBeLessThan(
      text.indexOf("Old answered question"),
    );
  });

  it("includes every handoff brief field on the open exchange", async () => {
    const { runId } = await insertFixture({
      exchanges: [
        {
          v: 1,
          at: at(6),
          question: "Choose",
          handoff: {
            workDone: "Mapped the current flow",
            filesTouched: ["src/auth.ts"],
            commandsRun: ["bun test auth"],
            decision: "Choose the session store",
            options: ["Mongo", "Redis"],
            risk: "Migration compatibility",
          },
          answer: null,
          answeredAt: null,
        },
      ],
    });

    const { text } = await buildRunContext(runId);

    for (const value of [
      "Mapped the current flow",
      "src/auth.ts",
      "bun test auth",
      "Choose the session store",
      "Mongo",
      "Redis",
      "Migration compatibility",
    ]) {
      expect(text).toContain(value);
    }
  });

  it("never reads or emits raw stdout/stderr log text", async () => {
    process.env.T4D_TEST_TOKEN = "planted-secret-1234";
    const repo = await makeRepo();
    const logFile = join(repo.workDir, "runner.log");
    const stderrFile = join(repo.workDir, "runner.stderr.log");
    await writeFile(logFile, "raw planted-secret-1234 stdout");
    await writeFile(stderrFile, "raw planted-secret-1234 stderr");
    guardedAccess.paths.add(logFile);
    guardedAccess.paths.add(stderrFile);
    const { runId } = await insertFixture({
      workDir: repo.workDir,
      baseSha: repo.baseSha,
      logFile,
      stderrFile,
    });

    const { text } = await buildRunContext(runId);

    expect(guardedAccess.attempted).toEqual([]);
    expect(text).not.toContain("planted-secret-1234");
    expect(text).not.toContain("planted-secret");
  });

  it("redacts secrets echoed into handoff fields and git commit messages", async () => {
    process.env.T4D_TEST_TOKEN = "planted-secret-1234";
    const repo = await makeRepo();
    await writeFile(join(repo.workDir, "fixture.txt"), "changed\n");
    await execFileAsync("git", ["add", "fixture.txt"], { cwd: repo.workDir });
    await execFileAsync(
      "git",
      ["commit", "-qm", "echo planted-secret-1234 from runner"],
      { cwd: repo.workDir },
    );
    const { runId } = await insertFixture({
      workDir: repo.workDir,
      baseSha: repo.baseSha,
      exchanges: [
        {
          v: 1,
          at: at(6),
          question: "Choose",
          handoff: {
            workDone: "Observed planted-secret-1234 in structured output",
            filesTouched: [],
            commandsRun: [],
            decision: "Choose",
            options: [],
            risk: "",
          },
          answer: null,
          answeredAt: null,
        },
      ],
    });

    const { text } = await buildRunContext(runId);

    expect(text).not.toContain("planted-secret-1234");
    expect(text.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the uncapped spec and newest exchanges under the optional budget", async () => {
    const exchanges = Array.from({ length: 70 }, (_, index) => ({
      v: 1,
      at: new Date(Date.UTC(2026, 6, 23, 10, index)).toISOString(),
      question: `exchange-${index}-${"q".repeat(900)}`,
      handoff: null,
      answer: `answer-${index}-${"a".repeat(200)}`,
      answeredAt: new Date(Date.UTC(2026, 6, 23, 10, index, 1)).toISOString(),
    }));
    const { runId } = await insertFixture({ exchanges });

    const { text } = await buildRunContext(runId);
    const firstOptional = text.indexOf("## Exchange");
    const specLength = firstOptional === -1 ? text.length : firstOptional;

    expect(text.length).toBeLessThanOrEqual(
      RUN_CONTEXT_CHAR_BUDGET + specLength,
    );
    expect(text).toContain("Consult on authentication");
    expect(text).toContain("exchange-69-");
    expect(text).not.toContain("exchange-0-");
  });

  it("drops an overflowing section whole instead of ending inside it", async () => {
    const { runId } = await insertFixture({
      exchanges: [
        {
          v: 1,
          at: at(2),
          question: `START_OF_OVERSIZED_SECTION${"x".repeat(
            RUN_CONTEXT_CHAR_BUDGET,
          )}END_OF_OVERSIZED_SECTION`,
          handoff: null,
          answer: "answer",
          answeredAt: at(3),
        },
      ],
    });

    const { text } = await buildRunContext(runId);

    expect(text).not.toContain("START_OF_OVERSIZED_SECTION");
    expect(text).not.toContain("END_OF_OVERSIZED_SECTION");
    expect(text.endsWith("\n\n")).toBe(true);
  });

  it("stops at the first overflowing section to keep history contiguous", async () => {
    const { runId } = await insertFixture({
      exchanges: [
        {
          v: 1,
          at: at(2),
          question: "old-small-section",
          handoff: null,
          answer: "old answer",
          answeredAt: at(3),
        },
        {
          v: 1,
          at: at(4),
          question: `huge-middle-section${"x".repeat(
            RUN_CONTEXT_CHAR_BUDGET,
          )}`,
          handoff: null,
          answer: "middle answer",
          answeredAt: at(5),
        },
        {
          v: 1,
          at: at(6),
          question: "newest-small-section",
          handoff: null,
          answer: "newest answer",
          answeredAt: at(7),
        },
      ],
    });

    const { text } = await buildRunContext(runId);

    expect(text).toContain("newest-small-section");
    expect(text).not.toContain("huge-middle-section");
    expect(text).not.toContain("old-small-section");
  });

  it("uses the shared row-tolerant exchange projection seen by the human", async () => {
    const valid = {
      v: 1,
      at: at(2),
      question: "Visible valid question",
      handoff: null,
      answer: "Visible valid answer",
      answeredAt: at(3),
    };
    const invalid = {
      ...valid,
      v: 2,
      question: "INVALID ROW MUST STAY HIDDEN",
    };
    const raw = [valid, invalid];
    expect(projectExchanges(raw)).toMatchObject({
      exchanges: [valid],
      dropped: 1,
    });
    const { runId } = await insertFixture({ exchanges: raw });

    const { text } = await buildRunContext(runId);

    expect(text).toContain("Visible valid question");
    expect(text).not.toContain("INVALID ROW MUST STAY HIDDEN");
    expect(text).toContain("1 earlier exchange(s) omitted");
  });

  it("degrades git failure to a one-line note without failing the build", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "tosin4dev-not-git-"));
    tempDirs.push(workDir);
    const { runId } = await insertFixture({
      workDir,
      baseSha: "deadbeef",
      branch: "feat/not-a-repo",
    });

    const { text } = await buildRunContext(runId);

    expect(text).toContain("Consult on authentication");
    expect(text).toContain(
      "## Objective worktree facts\nGit worktree facts unavailable.\n\n",
    );
  });

  it("does not pass an invalid base SHA to git", async () => {
    const repo = await makeRepo();
    const { runId } = await insertFixture({
      workDir: repo.workDir,
      baseSha: "--upload-pack=evil",
    });
    guardedAccess.execFileCalls.length = 0;

    const { text } = await buildRunContext(runId);

    expect(guardedAccess.execFileCalls).toEqual([]);
    expect(text).toContain("Git worktree facts unavailable.");
  });

  it("uses execFile with argv arrays and no shell for git reads", async () => {
    const repo = await makeRepo();
    const { runId } = await insertFixture({
      workDir: repo.workDir,
      baseSha: repo.baseSha,
    });
    guardedAccess.execFileCalls.length = 0;

    const { text } = await buildRunContext(runId);

    expect(text).toContain("Git status:\n(clean)");
    expect(guardedAccess.execFileCalls).toEqual([
      {
        file: "git",
        args: ["status", "--porcelain"],
        options: expect.objectContaining({
          cwd: repo.workDir,
          timeout: 10_000,
        }),
      },
      {
        file: "git",
        args: ["log", "--oneline", `${repo.baseSha}..HEAD`],
        options: expect.objectContaining({
          cwd: repo.workDir,
          timeout: 10_000,
        }),
      },
    ]);
  });

  it("maps a malformed run id to a not-found server error", async () => {
    await expect(buildRunContext("not-an-object-id")).rejects.toMatchObject({
      name: "ServerResultError",
      code: "not_found",
      message: "run not found: not-an-object-id",
    });
  });
});
