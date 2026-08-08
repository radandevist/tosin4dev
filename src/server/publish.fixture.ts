import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test fixtures for the publish pipeline. Every execute-dispatch smoke test
// builds a temp repo with no `origin` remote, and the dispatch preflight now
// shells out to `git remote get-url origin` — so without a real origin every
// execute dispatch would throw `no_remote`. These helpers give the fixture
// repo a local bare origin (the push target preflight checks for) and install
// a `gh` shim FIRST on the stubbed PATH so no test ever reaches the
// developer's real GitHub auth state or touches the network.

// Create a local bare repo and register it as the fixture repo's `origin`.
// Returns the bare repo path so the test's afterAll can remove it.
export function addOriginRemote(repo: string, prefix: string): string {
  const origin = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", origin]);
  return origin;
}

// Install a `gh` shim into `binDirectory` (which every smoke test puts FIRST
// on the stubbed PATH). auth status passes, pr list finds no open PR, pr
// create returns a synthetic URL — enough for the publish path to run end to
// end without a real GitHub account or any network call.
export async function writeGhShim(binDirectory: string): Promise<void> {
  await writeFile(
    join(binDirectory, "gh"),
    [
      "#!/bin/sh",
      'if [ "$1" = "auth" ]; then echo "shim: logged in"; exit 0; fi',
      'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi',
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
      '  echo "https://github.com/tosin4dev/publyapp/pull/1"',
      "  exit 0",
      "fi",
      'echo "gh shim: unexpected args: $*" >&2',
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );
}
