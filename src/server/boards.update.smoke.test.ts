import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CHECK_KEY_LENGTH,
  MAX_CHECK_TIMEOUT_MS,
  UpdateBoardChecksSchema,
} from "../domain/schemas";
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
  listBoardsCore,
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
    // createBoardCore stamps createdAt and updatedAt with the same value.
    expect(before.createdAt).toBe(before.updatedAt);

    // Back-date the row to a timestamp the clock cannot produce. Comparing
    // against a value taken moments earlier would be same-millisecond flaky in
    // one direction and vacuous in the other (>= is satisfied by equality);
    // back-dating makes the refresh provable by strict inequality, no sleep.
    const STALE = "2000-01-01T00:00:00.000Z";
    await (await db())
      .collection("boards")
      .updateOne({ slug: "publyapp" }, { $set: { updatedAt: STALE } });

    const updated = await updateBoardChecksCore({ slug: "publyapp", checks: CHECKS });

    // The returned DTO is the persisted document, not a build-up of the input.
    expect(updated.checks).toEqual(CHECKS);
    expect(updated.updatedAt > STALE).toBe(true);
    expect(updated.updatedAt).not.toBe(STALE);
    // The refresh is persisted, not just present on the returned DTO.
    expect((await getBoardCore("publyapp")).updatedAt).not.toBe(STALE);
  });

  it("normalises a stored board with no checks field to an empty array", async () => {
    // Boards written before the checks feature (or hand-authored straight into
    // Mongo, which is how checks were configured until the editor landed) carry
    // no `checks` key at all. BoardDTO's type claims `checks` is always present,
    // so toDTO must normalise the missing field — every read path returns the
    // same [] instead of each consumer dereferencing undefined.
    await (await db()).collection("boards").insertOne({
      slug: "legacy",
      name: "Legacy",
      repoPath: "/home/radan/Projects/PublyApp",
      defaultBaseBranch: "develop",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    });

    expect((await getBoardCore("legacy")).checks).toEqual([]);
    const listed = await listBoardsCore();
    expect(listed.find((b) => b.slug === "legacy")?.checks).toEqual([]);
    expect(
      (
        await updateBoardChecksCore({
          slug: "legacy",
          checks: [{ key: "lint", label: "lint", command: ["echo", "ok"], timeoutMs: 10_000 }],
        })
      ).checks,
    ).toEqual([{ key: "lint", label: "lint", command: ["echo", "ok"], timeoutMs: 10_000 }]);
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

  it("rejects a key longer than MAX_CHECK_KEY_LENGTH", () => {
    const over = UpdateBoardChecksSchema.safeParse({
      slug: "publyapp",
      checks: [
        {
          key: "a".repeat(MAX_CHECK_KEY_LENGTH + 1),
          label: "too long",
          command: ["echo", "ok"],
        },
      ],
    });
    expect(over.success).toBe(false);

    const atLimit = UpdateBoardChecksSchema.safeParse({
      slug: "publyapp",
      checks: [
        {
          key: "a".repeat(MAX_CHECK_KEY_LENGTH),
          label: "at limit",
          command: ["echo", "ok"],
        },
      ],
    });
    expect(atLimit.success).toBe(true);
  });

  it("a key at the permitted maximum is a writable evidence filename", async () => {
    // `key` becomes <runDir>/checks/<key>.log, written by verifyRun's
    // writeFile. Pin the VALUE of MAX_CHECK_KEY_LENGTH: it must stay under the
    // filesystem's 255-byte per-name limit, so raising the cap into a territory
    // the filesystem rejects goes red instead of silently re-admitting a
    // durable ENAMETOOLONG denial of verification.
    const dir = await mkdtemp(join(tmpdir(), "t4d-key-"));
    try {
      const file = join(dir, `${"a".repeat(MAX_CHECK_KEY_LENGTH)}.log`);
      await writeFile(file, "ok");
      expect(await readFile(file, "utf8")).toBe("ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a timeoutMs above MAX_CHECK_TIMEOUT_MS", () => {
    // Node's child_process timeout is a setTimeout delay. Above 2^31-1 it
    // silently clamps to 1ms (instantly SIGTERM'ing the check); below that a
    // single hung check parks the supervisor for days. The cap is what makes
    // both values rejected at the schema instead of at runtime.
    for (const bad of [3_000_000_000, 2_000_000_000]) {
      const parsed = UpdateBoardChecksSchema.safeParse({
        slug: "publyapp",
        checks: [{ key: "lint", label: "lint", command: ["echo", "ok"], timeoutMs: bad }],
      });
      expect(parsed.success).toBe(false);
    }
    const atLimit = UpdateBoardChecksSchema.safeParse({
      slug: "publyapp",
      checks: [{ key: "lint", label: "lint", command: ["echo", "ok"], timeoutMs: MAX_CHECK_TIMEOUT_MS }],
    });
    expect(atLimit.success).toBe(true);
  });

  it("the permitted maximum timeout does not overflow a 32-bit delay", () => {
    // Constant guard, not a behaviour test: raising the cap to a value
    // setTimeout cannot represent must go red instead of silently re-admitting
    // the exact bug the cap excludes.
    expect(MAX_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(2 ** 31 - 1);
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
