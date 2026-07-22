import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyRun } from "./verify.server";

const exec = promisify(execFile);

async function initRepo(): Promise<{ repo: string; baseSha: string }> {
  const repo = await mkdtemp(join(tmpdir(), "t4d-vf-"));
  await exec("git", ["-C", repo, "init", "-b", "main"]);
  await exec("git", ["-C", repo, "config", "user.email", "t@t"]);
  await exec("git", ["-C", repo, "config", "user.name", "t"]);
  await exec("git", ["-C", repo, "commit", "--allow-empty", "-m", "root"]);
  const baseSha = (await exec("git", ["-C", repo, "rev-parse", "main"])).stdout.trim();
  return { repo, baseSha };
}

describe("verifyRun", () => {
  let repo: string; let baseSha: string; let workDir: string;
  beforeEach(async () => {
    ({ repo, baseSha } = await initRepo());
    workDir = join(repo, ".t4d/wt");
    await exec("git", ["-C", repo, "worktree", "add", "-b", "tosin4dev/run/r", workDir, "main"]);
  });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  it("fails with no_commit when the worktree has no new commit", async () => {
    const res = await verifyRun({
      repoPath: repo, workDir, runDir: join(repo, ".t4d/runs/r"),
      branch: "tosin4dev/run/r", baseSha, checks: [], at: "2026-07-22T00:00:00.000Z",
    });
    expect(res.verdict).toBe("failed");
    expect(res.failureKind).toBe("no_commit");
  });

  it("passes when a commit exists and the check exits 0", async () => {
    await writeFile(join(workDir, "f.txt"), "x");
    await exec("git", ["-C", workDir, "add", "."]);
    await exec("git", ["-C", workDir, "commit", "-m", "work"]);
    const res = await verifyRun({
      repoPath: repo, workDir, runDir: join(repo, ".t4d/runs/r"),
      branch: "tosin4dev/run/r", baseSha,
      checks: [{ key: "true", label: "true", command: ["git", "--version"], timeoutMs: 10000 }],
      at: "2026-07-22T00:00:00.000Z",
    });
    expect(res.verdict).toBe("passed");
    expect(res.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.checks[0].exitCode).toBe(0);
  });

  it("fails verification when a check exits nonzero", async () => {
    await writeFile(join(workDir, "f.txt"), "x");
    await exec("git", ["-C", workDir, "add", "."]);
    await exec("git", ["-C", workDir, "commit", "-m", "work"]);
    const res = await verifyRun({
      repoPath: repo, workDir, runDir: join(repo, ".t4d/runs/r"),
      branch: "tosin4dev/run/r", baseSha,
      checks: [{ key: "fail", label: "fail", command: ["git", "rev-parse", "nope-nope"], timeoutMs: 10000 }],
      at: "2026-07-22T00:00:00.000Z",
    });
    expect(res.verdict).toBe("failed");
    expect(res.failureKind).toBe("verification_failed");
    expect(res.checks[0].exitCode).not.toBe(0);
  });
});
