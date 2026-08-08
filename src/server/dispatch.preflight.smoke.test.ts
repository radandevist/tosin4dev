import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Point the lazy db() singleton at a throwaway database *before* anything
// triggers a connection. Unique per run so parallel suites never collide.
const TEST_DB = `tosin4dev-test-dispatch-preflight-${process.pid}-${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;

const { db, closeDb } = await import("./db");
const { dispatchRun } = await import("./supervisor.server");

let binDirectory: string;

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

// A real, billable `claude` sits on PATH in this environment (with live auth
// tokens) and a real authenticated `gh` is there too. The runner spawn and the
// publish preflight shell out to those names, so PATH is stubbed per test.
// `git` is the only binary the suite needs from the real world (the fixture
// shells out to it), and /usr/bin (where it lives) also holds the real `gh` —
// so the suite symlinks git into a directory it OWNS and points PATH there,
// keeping every real claude/gh directory out of the stubbed PATH entirely.
// symlink() creates the link atomically, so a failure leaves no partial file.
const ORIGINAL_PATH = process.env.PATH;

let gitDir: string;

async function setupGitDir(): Promise<void> {
  gitDir = await mkdtemp(join(tmpdir(), "dispatch-git-"));
  try {
    const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    await symlink(gitPath, join(gitDir, "git"));
  } catch (err) {
    await rm(gitDir, { recursive: true, force: true });
    throw err;
  }
}

// The stubbed PATH is exactly `extra:gitDir` — the gh shim dir and the git
// symlink, and nothing else. The preflight's subprocesses are `gh` (the shim),
// `git` (the symlink), and the acceptance check `true` (shell builtin); the
// runner spawn looks for `claude`, which is absent, so it fails with ENOENT
// and dispatch rejects with spawn_failed instead of launching a real agent. A
// real `claude` or `gh` cannot resolve because their directories are never in
// the list.
function stubPath(extra: string): string {
  return [extra, gitDir].filter(Boolean).join(":");
}

describe("dispatchRun acceptance-check preflight", () => {
  beforeAll(async () => {
    // Empty by design: this suite's only subprocess needs are `git` (via the
    // gitDir symlink) and the gh shim the no_remote test drops into its own
    // directory. Nothing writes into binDirectory, so a test that ASSUMES it is
    // empty (e.g. "the runner lookup fails with ENOENT") never silently
    // resolves a leftover executable.
    binDirectory = await mkdtemp(join(tmpdir(), "dispatch-preflight-"));
    await setupGitDir();
  });

  afterAll(async () => {
    await (await db()).dropDatabase();
    await closeDb();
    process.env.PATH = ORIGINAL_PATH;
    await rm(binDirectory, { recursive: true, force: true });
    await rm(gitDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    process.env.PATH = stubPath(binDirectory);
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

  it("refuses an execute run with no_remote before anything is claimed", async () => {
    // The Task 1 checks guard runs first, so the board needs checks for the
    // publish preflight to be reached at all. The repo path is a temp dir with
    // no `origin`, so preflightPublish fails with no_remote.
    const dir = await mkdtemp(join(tmpdir(), "t4d-no-origin-"));
    // `gh auth status` runs before the git remote check, so PATH needs a gh
    // shim that passes auth for the git check to be reached. The shim lives in
    // its OWN directory — binDirectory stays empty (its beforeAll invariant) —
    // and that directory is prepended to the gitDir symlink. `git` resolves
    // from gitDir, so the remote check below genuinely fails because the repo
    // HAS no origin, not because git is missing (the bug this test used to
    // mask).
    const ghDir = await mkdtemp(join(tmpdir(), "t4d-gh-"));
    try {
      await writeFile(
        join(ghDir, "gh"),
        '#!/bin/sh\necho "shim: logged in"\nexit 0\n',
        { mode: 0o755 },
      );
    } catch (err) {
      await rm(ghDir, { recursive: true, force: true });
      throw err;
    }
    process.env.PATH = stubPath(ghDir);
    const database = await db();
    const boardId = new ObjectId();
    const at = "2026-08-07T00:00:00.000Z";
    await database.collection("boards").insertOne({
      _id: boardId,
      slug: `no-origin-${process.pid}-${Date.now()}`,
      name: "No Origin",
      repoPath: dir,
      defaultBaseBranch: "develop",
      checks: [{ key: "ok", label: "ok", command: ["true"], timeoutMs: 10_000 }],
      createdAt: at,
      updatedAt: at,
    });
    const ticketId = new ObjectId();
    await database.collection("tickets").insertOne({
      _id: ticketId,
      boardId: boardId.toString(),
      seq: 2,
      title: "t",
      type: "implement",
      status: "approved",
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
        approvedAt: at,
        approvedBy: "radan",
      },
      createdAt: at,
      updatedAt: at,
    });

    await expect(dispatchRun(ticketId.toString(), "execute")).rejects.toMatchObject({
      code: "no_remote",
    });

    // The preflight refuses before anything is claimed or a run is created.
    const ticket = await database
      .collection("tickets")
      .findOne({ _id: new ObjectId(ticketId) });
    expect(ticket?.activeRunId).toBeNull();
    expect(ticket?.status).toBe("approved");
    expect(await database.collection("runs").countDocuments()).toBe(0);
    await rm(dir, { recursive: true, force: true });
    await rm(ghDir, { recursive: true, force: true });
    process.env.PATH = ORIGINAL_PATH;
  });

  it("refuses a review_fix run with no_remote before anything is claimed", async () => {
    // The publish block runs for every phase but spec_draft, so the preflight
    // must cover review_fix too — a direct call reaches it even though the UI
    // only offers spec_draft and execute. Same fixture shape as the execute
    // case: a temp repo with no origin, a gh auth shim on a stubbed PATH that
    // replaces the original so the real authenticated gh can never resolve.
    const dir = await mkdtemp(join(tmpdir(), "t4d-no-origin-rf-"));
    const ghDir = await mkdtemp(join(tmpdir(), "t4d-gh-rf-"));
    try {
      await writeFile(
        join(ghDir, "gh"),
        '#!/bin/sh\necho "shim: logged in"\nexit 0\n',
        { mode: 0o755 },
      );
    } catch (err) {
      await rm(ghDir, { recursive: true, force: true });
      throw err;
    }
    process.env.PATH = stubPath(ghDir);
    const database = await db();
    const boardId = new ObjectId();
    const at = "2026-08-07T00:00:00.000Z";
    await database.collection("boards").insertOne({
      _id: boardId,
      slug: `no-origin-rf-${process.pid}-${Date.now()}`,
      name: "No Origin Review Fix",
      repoPath: dir,
      defaultBaseBranch: "develop",
      checks: [{ key: "ok", label: "ok", command: ["true"], timeoutMs: 10_000 }],
      createdAt: at,
      updatedAt: at,
    });
    const ticketId = new ObjectId();
    await database.collection("tickets").insertOne({
      _id: ticketId,
      boardId: boardId.toString(),
      seq: 3,
      title: "t",
      type: "implement",
      // review_fix requires a running ticket.
      status: "running",
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
        approvedAt: at,
        approvedBy: "radan",
      },
      createdAt: at,
      updatedAt: at,
    });

    await expect(dispatchRun(ticketId.toString(), "review_fix")).rejects.toMatchObject({
      code: "no_remote",
    });

    // The preflight refuses before anything is claimed or a run is created.
    const ticket = await database
      .collection("tickets")
      .findOne({ _id: new ObjectId(ticketId) });
    expect(ticket?.activeRunId).toBeNull();
    expect(ticket?.status).toBe("running");
    expect(await database.collection("runs").countDocuments()).toBe(0);
    await rm(dir, { recursive: true, force: true });
    await rm(ghDir, { recursive: true, force: true });
    process.env.PATH = ORIGINAL_PATH;
  });
});
