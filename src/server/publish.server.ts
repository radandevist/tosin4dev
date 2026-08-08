import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Board } from "../domain/schemas";
import { ServerResultError } from "./result";

const execFileAsync = promisify(execFile);

// Pure argv. `--draft` is not configurable: merging is the owner's action and
// nothing in this app may mark a PR ready for review.
export function draftPrArgs(input: {
  base: string;
  head: string;
  title: string;
  bodyFile: string;
}): string[] {
  return [
    "pr", "create",
    "--draft",
    "--base", input.base,
    "--head", input.head,
    "--title", input.title,
    "--body-file", input.bodyFile,
  ];
}

// The run branch is namespaced (tosin4dev/run/<runId>) so colliding with the
// base is already near-impossible. Assert anyway: "never touch develop
// directly" is a standing rule, and an assertion is how a rule stays true when
// the naming scheme later changes.
export function assertPublishable(board: Board, branch: string): void {
  if (branch.length === 0) {
    throw new ServerResultError("not_publishable", "run has no branch to publish");
  }
  if (branch === board.defaultBaseBranch) {
    throw new ServerResultError(
      "not_publishable",
      `refusing to push the base branch "${branch}" directly`,
    );
  }
}

// Checked at DISPATCH, not at push. Discovering a broken token after twenty
// minutes of agent work is the worst available ordering.
export async function preflightPublish(repoPath: string): Promise<void> {
  try {
    await execFileAsync("gh", ["auth", "status"], { encoding: "utf8" });
  } catch {
    throw new ServerResultError(
      "gh_unauthenticated",
      "gh is not authenticated — run `gh auth login` before dispatching",
    );
  }
  try {
    await execFileAsync("git", ["-C", repoPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
    });
  } catch {
    throw new ServerResultError(
      "no_remote",
      `repo at ${repoPath} has no "origin" remote to push to`,
    );
  }
}

// Plain push. Never --force, never --force-with-lease: a rejected push is
// information, and this branch is namespaced per run so a rejection means
// something genuinely unexpected happened.
export async function pushBranch(workDir: string, branch: string): Promise<void> {
  await execFileAsync("git", ["-C", workDir, "push", "-u", "origin", branch], {
    encoding: "utf8",
  });
}

// Reuse an existing PR for this head rather than opening a second one — the fix
// loop can reach a passing verdict on a branch that was already published.
async function existingPrUrl(workDir: string, branch: string): Promise<string | null> {
  const { stdout } = await execFileAsync(
    "gh",
    ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--limit", "1"],
    { cwd: workDir, encoding: "utf8" },
  );
  const parsed: unknown = JSON.parse(stdout || "[]");
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const url = (parsed[0] as { url?: unknown }).url;
  return typeof url === "string" ? url : null;
}

export async function publishRun(input: {
  board: Board;
  title: string;
  workDir: string;
  branch: string;
  bodyFile: string;
}): Promise<{ prUrl: string }> {
  assertPublishable(input.board, input.branch);
  await pushBranch(input.workDir, input.branch);
  const existing = await existingPrUrl(input.workDir, input.branch);
  if (existing !== null) return { prUrl: existing };
  const { stdout } = await execFileAsync(
    "gh",
    draftPrArgs({
      base: input.board.defaultBaseBranch,
      head: input.branch,
      title: input.title,
      bodyFile: input.bodyFile,
    }),
    { cwd: input.workDir, encoding: "utf8" },
  );
  return { prUrl: stdout.trim() };
}
