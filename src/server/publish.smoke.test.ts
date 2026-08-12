import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeGhShim } from "./publish.fixture";
import { publishRun, pushBranch } from "./publish.server";

const exec = promisify(execFile);

let origin: string;
let clone: string;
let binDirectory: string;
const ORIGINAL_PATH = process.env.PATH;

describe("pushBranch", () => {
  beforeEach(async () => {
    origin = await mkdtemp(join(tmpdir(), "t4d-origin-"));
    await exec("git", ["-C", origin, "init", "--bare", "-b", "develop"]);
    clone = await mkdtemp(join(tmpdir(), "t4d-clone-"));
    await exec("git", ["clone", origin, clone]);
    await exec("git", ["-C", clone, "config", "user.email", "t@t"]);
    await exec("git", ["-C", clone, "config", "user.name", "t"]);
    await exec("git", ["-C", clone, "commit", "--allow-empty", "-m", "root"]);
    await exec("git", ["-C", clone, "push", "-u", "origin", "develop"]);
    await exec("git", ["-C", clone, "checkout", "-b", "tosin4dev/run/abc"]);
    await writeFile(join(clone, "f.txt"), "x");
    await exec("git", ["-C", clone, "add", "."]);
    await exec("git", ["-C", clone, "commit", "-m", "work"]);
    binDirectory = await mkdtemp(join(tmpdir(), "t4d-pbin-"));
    await writeGhShim(binDirectory);
    process.env.PATH = `${binDirectory}:${ORIGINAL_PATH ?? ""}`;
  });
  afterEach(async () => {
    process.env.PATH = ORIGINAL_PATH;
    await rm(origin, { recursive: true, force: true });
    await rm(clone, { recursive: true, force: true });
    await rm(binDirectory, { recursive: true, force: true });
  });

  it("pushes the run branch to origin", async () => {
    await pushBranch(clone, "tosin4dev/run/abc");
    const { stdout } = await exec("git", ["-C", origin, "branch", "--list", "tosin4dev/run/abc"]);
    expect(stdout.trim()).toContain("tosin4dev/run/abc");
  });

  it("leaves the local branch intact when the push fails", async () => {
    await exec("git", ["-C", clone, "remote", "set-url", "origin", join(tmpdir(), "t4d-missing-remote")]);
    await expect(pushBranch(clone, "tosin4dev/run/abc")).rejects.toThrow();
    // The verified commit must survive a failed network call.
    const { stdout } = await exec("git", ["-C", clone, "branch", "--list", "tosin4dev/run/abc"]);
    expect(stdout.trim()).toContain("tosin4dev/run/abc");
    const { stdout: log } = await exec("git", ["-C", clone, "log", "-1", "--format=%s"]);
    expect(log.trim()).toBe("work");
  });

  describe("publishRun", () => {
    const BOARD = {
      slug: "publyapp",
      name: "PublyApp",
      repoPath: "/unused",
      defaultBaseBranch: "develop",
      checks: [],
    };

    beforeEach(async () => {
      await exec("git", ["-C", clone, "remote", "set-url", "origin", origin]);
    });

    it("reuses an existing PR for the head and does not call pr create", async () => {
      process.env.T4D_SHIM_PR_LIST = '[{"url":"https://github.com/tosin4dev/publyapp/pull/7"}]';
      // The shim logs every invocation to T4D_SHIM_LOG, so this test can prove
      // pr create never ran — the URL alone cannot see an extra call (an
      // implementation that creates AND returns the existing URL would still
      // pass), and a duplicate PR is exactly what the reuse path exists to stop.
      const shimLog = join(clone, "gh-argv.log");
      process.env.T4D_SHIM_LOG = shimLog;
      try {
        const result = await publishRun({
          board: BOARD,
          title: "#1 confetti",
          workDir: clone,
          branch: "tosin4dev/run/abc",
          bodyFile: join(clone, "body.md"),
        });
        expect(result.prUrl).toBe("https://github.com/tosin4dev/publyapp/pull/7");
        const argv = await readFile(shimLog, "utf8");
        expect(argv).not.toContain("pr create");
        expect(argv).toContain("pr list");
      } finally {
        delete process.env.T4D_SHIM_PR_LIST;
        delete process.env.T4D_SHIM_LOG;
      }
      // The reuse path looks the PR up BEFORE pushing: a branch that already
      // has an open PR is already on the remote, so the publish must not push
      // it again. A push-first implementation would leave the branch here.
      const { stdout } = await exec("git", ["-C", origin, "branch", "--list", "tosin4dev/run/abc"]);
      expect(stdout.trim()).not.toContain("tosin4dev/run/abc");
    });

    it("creates a PR when the shim reports no existing PR", async () => {
      // Production writes the body file before gh pr create runs; the shim now
      // refuses a create whose --body-file is missing or empty, so the test
      // has to mirror the real ordering.
      await writeFile(join(clone, "body.md"), "# PR body\n");
      const result = await publishRun({
        board: BOARD,
        title: "#1 confetti",
        workDir: clone,
        branch: "tosin4dev/run/abc",
        bodyFile: join(clone, "body.md"),
      });
      expect(result.prUrl).toBe("https://github.com/tosin4dev/publyapp/pull/1");
    });

    it("fails closed when the gh shim sees a pr create without --draft", async () => {
      // The shim is what protects production: if draftPrArgs ever drops the
      // literal, every smoke publish would run through a create that the shim
      // refuses instead of silently opening a ready-for-review PR.
      const ghPath = join(binDirectory, "gh");
      await expect(exec(ghPath, ["pr", "create", "--base", "main"])).rejects.toMatchObject({
        code: 1,
      });
      await writeFile(join(clone, "body.md"), "# PR body\n");
      await expect(
        exec(ghPath, ["pr", "create", "--draft", "--base", "main", "--body-file", join(clone, "body.md")]),
      ).resolves.toMatchObject({ stdout: expect.stringContaining("pull/1") });
    });
  });
});
