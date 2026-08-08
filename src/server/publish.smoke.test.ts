import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pushBranch } from "./publish.server";

const exec = promisify(execFile);

let origin: string;
let clone: string;

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
  });
  afterEach(async () => {
    await rm(origin, { recursive: true, force: true });
    await rm(clone, { recursive: true, force: true });
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
});
