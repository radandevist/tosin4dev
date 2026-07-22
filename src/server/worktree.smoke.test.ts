import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunBranch, runBranchName } from "./supervisor.server";

const exec = promisify(execFile);

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "t4d-wt-"));
  await exec("git", ["-C", dir, "init", "-b", "main"]);
  await exec("git", ["-C", dir, "config", "user.email", "t@t"]);
  await exec("git", ["-C", dir, "config", "user.name", "t"]);
  await exec("git", ["-C", dir, "commit", "--allow-empty", "-m", "root"]);
  return dir;
}

describe("createRunBranch", () => {
  let repo: string;
  beforeEach(async () => { repo = await initRepo(); });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  it("creates a named worktree branch and returns the base sha", async () => {
    const workDir = join(repo, ".tosin4dev/worktrees/run1");
    const { branch, baseSha } = await createRunBranch(repo, workDir, "main", "run1");
    expect(branch).toBe(runBranchName("run1"));
    expect(baseSha).toMatch(/^[0-9a-f]{40}$/);
    const { stdout } = await exec("git", ["-C", repo, "branch", "--list", branch]);
    expect(stdout).toContain(branch);
  });
});
