import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Board } from "../domain/schemas";
import { HttpUrlString } from "../domain/schemas";
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

// A shape from a subprocess is never trusted. `gh pr create` prints a bare URL
// line when it succeeds — but also prints notices/banners on other channels and
// can be re-versioned to print more than one line. HttpUrlString is the only
// thing allowed to turn that stdout into a URL; anything else is a diagnosed
// failure, not a silent garbage write into the database. `gh pr list --json
// url` prints an array of { url } objects — or a non-JSON error/notice prefix
// when something is off. The listing's URL fields are HttpUrlString too: a
// reuse URL that is not a real http(s) URL must NOT be returned, or it would be
// persisted as the run's prUrl and FIX the run's own schema parse later.
// Whatever the cause, a miss on this schema must mean "no existing PR" (so the
// create still runs), not a hard failure that blocks publishing. A bad create
// URL is a diagnosis; a bad listing is just no reuse candidate.
const PrListOutputSchema = z.array(z.object({ url: HttpUrlString }));

// Subprocess stdout is untrusted at this boundary: `gh pr list` can prefix its
// JSON with notices or emit an error string, and a SyntaxError there must not
// block the publish — the branch is already pushed, and a reuse miss just means
// the create runs. Any shape that fails the schema reads as "no existing PR".
// Exported as a pure seam so the parse is testable without invoking `gh`.
export function parsePrListOutput(stdout: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout || "[]");
  } catch {
    // Not JSON at all — no existing PR to reuse, let the create run.
    return null;
  }
  const parsed = PrListOutputSchema.safeParse(raw);
  if (!parsed.success || parsed.data.length === 0) return null;
  return parsed.data[0].url;
}

// The created PR's URL. `.url()` alone accepts javascript:/mailto:, so the
// protocol is pinned too, and whatever gh actually printed is named in the
// failure so the operator can act on it rather than on a bare schema error.
// Exported as a pure seam so the parse is testable without invoking `gh`.
export function parseCreatedPrUrl(stdout: string): string {
  const parsed = HttpUrlString.safeParse(stdout.trim());
  if (!parsed.success) {
    const shown = stdout.trim().slice(0, 300) || "<empty>";
    throw new ServerResultError(
      "unparseable_pr_url",
      `gh pr create printed no usable URL (got: ${JSON.stringify(shown)})`,
    );
  }
  return parsed.data;
}

// Reuse an existing PR for this head rather than opening a second one — the fix
// loop can reach a passing verdict on a branch that was already published.
async function existingPrUrl(workDir: string, branch: string): Promise<string | null> {
  const { stdout } = await execFileAsync(
    "gh",
    ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--limit", "1"],
    { cwd: workDir, encoding: "utf8" },
  );
  return parsePrListOutput(stdout);
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
  return { prUrl: parseCreatedPrUrl(stdout) };
}
