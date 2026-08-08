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
// on the stubbed PATH). auth status passes, pr list finds no open PR by
// default, pr create returns a synthetic URL — enough for the publish path to
// run end to end without a real GitHub account or any network call.
// T4D_SHIM_PR_LIST lets a test report an already-open PR (default `[]`, so
// every current fixture behaves exactly as before); the create path refuses a
// `pr create` without `--draft`, because that is the one irreversible flag.
// The create path also requires a `--body-file` that exists and is non-empty:
// production gh fails loudly when the body file is missing, and the shim has
// to fail the same way or deleting the body-file write in the supervisor
// would break no test. T4D_SHIM_LOG, when set, appends each argv to that file
// so a test can prove `pr create` was never invoked, not just that some URL
// came back.
export async function writeGhShim(binDirectory: string): Promise<void> {
  await writeFile(
    join(binDirectory, "gh"),
    [
      "#!/bin/sh",
      'if [ -n "$T4D_SHIM_LOG" ]; then printf "%s\\n" "$*" >> "$T4D_SHIM_LOG"; fi',
      'if [ "$1" = "auth" ]; then echo "shim: logged in"; exit 0; fi',
      'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then',
      '  echo "${T4D_SHIM_PR_LIST:-[]}"',
      "  exit 0",
      "fi",
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
      // `--draft` is the one irreversible flag: dropping it opens a
      // ready-for-review PR on a real repo. Refuse any create that lacks it so
      // the whole smoke suite fails if draftPrArgs ever loses the literal.
      '  case "$*" in *--draft*) ;; *) echo "shim: pr create without --draft" >&2; exit 1;; esac',
      // The body file is how the verification evidence reaches the PR. Real gh
      // errors on a missing file, so the shim must too, or a deleted write
      // would silently stop pinning prBody and the token neutralisation.
      '  body_file=""',
      '  while [ "$#" -gt 0 ]; do',
      '    if [ "$1" = "--body-file" ]; then body_file="$2"; shift 2; else shift; fi',
      '  done',
      '  if [ -z "$body_file" ]; then echo "shim: pr create without --body-file" >&2; exit 1; fi',
      '  if [ ! -f "$body_file" ] || [ ! -s "$body_file" ]; then echo "shim: pr create body file missing or empty: $body_file" >&2; exit 1; fi',
      '  echo "https://github.com/tosin4dev/publyapp/pull/1"',
      "  exit 0",
      "fi",
      'echo "gh shim: unexpected args: $*" >&2',
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );
}
