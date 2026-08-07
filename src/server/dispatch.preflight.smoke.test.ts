import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the lazy db() singleton at a throwaway database *before* anything
// triggers a connection. Unique per run so parallel suites never collide.
const TEST_DB = `tosin4dev-test-dispatch-preflight-${process.pid}-${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;

const { db, closeDb } = await import("./db");
const { dispatchRun } = await import("./supervisor.server");

let binDirectory: string;
const ORIGINAL_PATH = process.env.PATH;

async function seed(
  checks: unknown[],
  status: "inbox" | "approved" = "approved",
): Promise<string> {
  const database = await db();
  await database.collection("boards").deleteMany({});
  await database.collection("tickets").deleteMany({});
  await database.collection("runs").deleteMany({});
  const boardId = new ObjectId();
  await database.collection("boards").insertOne({
    _id: boardId,
    slug: "publyapp",
    name: "PublyApp",
    repoPath: "/tmp/does-not-need-to-exist",
    defaultBaseBranch: "develop",
    checks,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  });
  const ticketId = new ObjectId();
  await database.collection("tickets").insertOne({
    _id: ticketId,
    boardId: boardId.toString(),
    seq: 1,
    title: "t",
    type: "implement",
    status,
    runner: "claude",
    activeRunId: null,
    dependsOn: [],
    activity: [],
    spec: {
      intent: "do the thing",
      scope: "",
      nonGoals: "",
      acceptance: ["it works"],
      links: [],
      risk: "low",
      approvedAt: "2026-08-07T00:00:00.000Z",
      approvedBy: "radan",
    },
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  });
  return ticketId.toString();
}

describe("dispatchRun acceptance-check preflight", () => {
  beforeAll(async () => {
    // spec_draft bypasses the guard and reaches the spawn, so point PATH at an
    // empty bin dir: the runner lookup fails with ENOENT and dispatch rejects
    // with spawn_failed instead of launching a real `claude` on PATH.
    binDirectory = await mkdtemp(join(tmpdir(), "dispatch-preflight-"));
  });

  afterAll(async () => {
    await (await db()).dropDatabase();
    await closeDb();
    process.env.PATH = ORIGINAL_PATH;
    await rm(binDirectory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    process.env.PATH = binDirectory;
    const database = await db();
    await database.collection("runs").deleteMany({});
  });

  it("refuses to dispatch an execute run when the board has no checks", async () => {
    const ticketId = await seed([]);
    await expect(dispatchRun(ticketId, "execute")).rejects.toMatchObject({
      code: "no_acceptance_checks",
    });
  });

  it("leaves the ticket unclaimed when the preflight refuses", async () => {
    const ticketId = await seed([]);
    await dispatchRun(ticketId, "execute").catch(() => undefined);
    const database = await db();
    const ticket = await database
      .collection("tickets")
      .findOne({ _id: new ObjectId(ticketId) });
    expect(ticket?.activeRunId).toBeNull();
    expect(ticket?.status).toBe("approved");
    expect(await database.collection("runs").countDocuments()).toBe(0);
  });

  it("does not refuse a spec_draft run on a checkless board", async () => {
    const ticketId = await seed([], "inbox");
    const error = await dispatchRun(ticketId, "spec_draft").catch(
      (e: unknown) => e,
    );
    // It still fails — the stubbed PATH has no `claude` — but it must not fail
    // for THIS reason: a fresh board has no checks, and drafting a spec is how
    // a user gets any.
    expect((error as { code?: string }).code).not.toBe("no_acceptance_checks");
  });
});
