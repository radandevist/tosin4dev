import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { UpdateBoardChecksSchema } from "../domain/schemas";
import { verifyRun } from "./verify.server";

const exec = promisify(execFile);

// Point the lazy db() singleton at a throwaway database *before* anything
// triggers a connection. Unique per run so parallel suites never collide.
const TEST_DB = `tosin4dev-test-board-checks-${process.pid}-${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;

const { db, closeDb } = await import("./db");
const {
  createBoardCore,
  getBoardCore,
  updateBoardChecksCore,
} = await import("./boards.server");

const BOARD = {
  slug: "publyapp",
  name: "PublyApp",
  repoPath: "/home/radan/Projects/PublyApp",
  defaultBaseBranch: "develop",
  checks: [],
};

const CHECKS = [
  { key: "lint", label: "lint", command: ["echo", "ok"], timeoutMs: 10_000 },
  { key: "test", label: "test", command: ["echo", "ok"], timeoutMs: 10_000 },
];

describe("updateBoardChecksCore", () => {
  beforeEach(async () => {
    await (await db()).collection("boards").deleteMany({});
  });

  afterAll(async () => {
    await (await db()).dropDatabase();
    await closeDb();
  });

  it("replaces a board's checks and refreshes updatedAt", async () => {
    await createBoardCore(BOARD);
    const before = await getBoardCore("publyapp");
    expect(before.checks).toEqual([]);

    const updated = await updateBoardChecksCore({ slug: "publyapp", checks: CHECKS });

    // The returned DTO is the persisted document, not a build-up of the input.
    expect(updated.checks).toEqual(CHECKS);
    // updatedAt is refreshed in the same atomic write; it can never run backwards.
    expect(updated.updatedAt >= before.updatedAt).toBe(true);

    const reread = await getBoardCore("publyapp");
    expect(reread.checks).toEqual(CHECKS);
  });

  it("rejects an unknown slug with not_found", async () => {
    await expect(
      updateBoardChecksCore({ slug: "does-not-exist", checks: CHECKS }),
    ).rejects.toThrow("board not found: does-not-exist");
  });

  it("rejects duplicate check keys", () => {
    const parsed = UpdateBoardChecksSchema.safeParse({
      slug: "publyapp",
      checks: [
        { key: "dup", label: "a", command: ["echo", "ok"] },
        { key: "dup", label: "b", command: ["echo", "ok"] },
      ],
    });
    expect(parsed.success).toBe(false);
    // The issue is reported against the offending key, not a generic array error.
    const message = parsed.success ? "" : parsed.error.message;
    expect(message).toMatch(/duplicate check key: dup/);
  });

  it("rejects an empty command array", () => {
    const parsed = UpdateBoardChecksSchema.safeParse({
      slug: "publyapp",
      checks: [{ key: "empty", label: "empty", command: [] }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a key violating the regex", () => {
    const parsed = UpdateBoardChecksSchema.safeParse({
      slug: "publyapp",
      checks: [{ key: "../etc/passwd", label: "bad", command: ["echo", "ok"] }],
    });
    expect(parsed.success).toBe(false);
  });

  it("an updated check is what verifyRun subsequently executes", async () => {
    // The regression this guards against: a UI/store update path that writes a
    // different field than the one verifyRun reads (e.g. only the UI state, or a
    // renamed checks key). Reverting the write (or writing to a field verifyRun
    // does not read) fails this test on its own expect.
    await createBoardCore(BOARD);
    await updateBoardChecksCore({
      slug: "publyapp",
      checks: [{ key: "detect", label: "detect", command: ["git", "--version"], timeoutMs: 10_000 }],
    });
    const { checks } = await getBoardCore("publyapp");

    const repo = await mkdtemp(join(tmpdir(), "t4d-upd-"));
    try {
      await exec("git", ["-C", repo, "init", "-b", "main"]);
      await exec("git", ["-C", repo, "config", "user.email", "t@t"]);
      await exec("git", ["-C", repo, "config", "user.name", "t"]);
      await exec("git", ["-C", repo, "commit", "--allow-empty", "-m", "root"]);
      const baseSha = (await exec("git", ["-C", repo, "rev-parse", "main"])).stdout.trim();
      const workDir = join(repo, ".t4d/wt");
      await exec("git", ["-C", repo, "worktree", "add", "-b", "tosin4dev/run/r", workDir, "main"]);
      await writeFile(join(workDir, "f.txt"), "x");
      await exec("git", ["-C", workDir, "add", "."]);
      await exec("git", ["-C", workDir, "commit", "-m", "work"]);

      const res = await verifyRun({
        repoPath: repo,
        workDir,
        runDir: join(repo, ".t4d/runs/r"),
        branch: "tosin4dev/run/r",
        baseSha,
        checks,
        at: "2026-08-06T00:00:00.000Z",
      });
      // verifyRun executed the UPDATED command (git --version), not the board's
      // original empty checks list — the check ran, produced evidence, and passed.
      expect(res.checks).toHaveLength(1);
      expect(res.checks[0].key).toBe("detect");
      expect(res.checks[0].exitCode).toBe(0);
      expect(res.verdict).toBe("passed");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
