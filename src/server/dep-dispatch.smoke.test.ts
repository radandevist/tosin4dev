import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const TEST_DB = `tosin4dev-test-dep-dispatch-${process.pid}-${Date.now()}`;
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
let repo: string;
let binDirectory: string;
let boardId: string;

const timestamp = () => new Date().toISOString();

async function writeRunner(): Promise<void> {
  const executable = join(binDirectory, "claude");
  await writeFile(
    executable,
    `#!/bin/sh
echo "artifact $$" > artifact.txt
git add -A
git commit -m "dependency smoke" >/dev/null 2>&1
printf '%s' '{"outcome":"completed","summary":"dependency smoke"}' > "$T4D_OUTCOME_PATH"
exit 0
`,
  );
  await chmod(executable, 0o755);
}

async function insertTicket(
  seq: number,
  status: Ticket["status"],
  dependsOn: string[],
): Promise<string> {
  const at = timestamp();
  const approved = status === "approved";
  const result = await tickets.insertOne({
    boardId,
    seq,
    title: `dependency ticket ${seq}`,
    type: "implement",
    status,
    runner: "claude",
    spec: {
      intent: "exercise dependency dispatch",
      scope: "README.md",
      nonGoals: "none",
      acceptance: [],
      links: [],
      risk: "low",
      approvedAt: approved ? at : null,
      approvedBy: approved ? "radan" : null,
    },
    activeRunId: null,
    prUrl: null,
    activity: [],
    dependsOn,
    createdAt: at,
    updatedAt: at,
  });
  return result.insertedId.toString();
}

async function waitForRunsToSettle(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = await runs.countDocuments({
      status: { $in: ["queued", "running", "verifying"] },
    });
    if (active === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("runs did not settle");
}

describe("dependency-serialized dispatch", () => {
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "t4d-dep-dispatch-repo-"));
    binDirectory = await mkdtemp(join(tmpdir(), "t4d-dep-dispatch-bin-"));
    execFileSync("git", ["init", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t4d@example.test"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Tosin4dev Test"]);
    await writeFile(join(repo, "README.md"), "dependency smoke\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);
    await writeRunner();
    process.env.PATH = `${binDirectory}:${ORIGINAL_PATH ?? ""}`;

    database = await db();
    boards = database.collection<BoardDoc>("boards");
    tickets = database.collection<TicketDoc>("tickets");
    runs = database.collection<RunDoc>("runs");
    const at = timestamp();
    const board = await boards.insertOne({
      slug: `dep-dispatch-${process.pid}-${Date.now()}`,
      name: "Dependency Dispatch",
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
    await tickets.deleteMany({});
    await runs.deleteMany({});
    await writeRunner();
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

  it("gates execute until every dependency is done and fails closed", async () => {
    const dependencyId = await insertTicket(1, "inbox", []);
    const dependentId = await insertTicket(2, "approved", [dependencyId]);

    await expect(dispatchRun(dependentId, "execute")).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/waiting on dependencies.*#1/),
    });

    for (const status of ["running", "review_ready"] as const) {
      await tickets.updateOne(
        { _id: new ObjectId(dependencyId) },
        { $set: { status } },
      );
      await expect(dispatchRun(dependentId, "execute")).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringMatching(/waiting on dependencies.*#1/),
      });
    }

    await tickets.updateOne(
      { _id: new ObjectId(dependencyId) },
      { $set: { status: "done" } },
    );
    await expect(dispatchRun(dependentId, "execute")).resolves.toEqual({
      runId: expect.any(String),
    });
    await expect(
      tickets.findOne({ _id: new ObjectId(dependentId) }),
    ).resolves.toMatchObject({ status: "running" });

    const missingId = new ObjectId().toString();
    const missingDependentId = await insertTicket(3, "approved", [missingId]);
    await expect(
      dispatchRun(missingDependentId, "execute"),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(
        new RegExp(`waiting on dependencies.*${missingId}.*missing`),
      ),
    });

    const independentId = await insertTicket(4, "approved", []);
    await expect(dispatchRun(independentId, "execute")).resolves.toEqual({
      runId: expect.any(String),
    });

    const draftId = await insertTicket(5, "inbox", [missingId]);
    try {
      await dispatchRun(draftId, "spec_draft");
    } catch (error) {
      expect(error).not.toMatchObject({
        message: expect.stringContaining("waiting on dependencies"),
      });
    }
    await waitForRunsToSettle();
  }, 20_000);
});
