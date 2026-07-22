import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Board, Evidence } from "../domain/schemas";

const execFileAsync = promisify(execFile);
const CHECK_OUTPUT_CAP = 256_000;

type CheckResult = Evidence["checks"][number];
type Verdict = { verdict: "passed" | "failed"; failureKind: "no_commit" | "verification_failed" | null };

// Pure decision: a run is verified iff it produced a reachable new commit AND
// every configured acceptance check exited 0. No checks configured => a commit
// alone passes (still strictly better than v1's "exit 0 = done").
export function verdictFrom(hasNewCommit: boolean, checks: CheckResult[]): Verdict {
  if (!hasNewCommit) return { verdict: "failed", failureKind: "no_commit" };
  if (checks.some((c) => c.exitCode !== 0)) {
    return { verdict: "failed", failureKind: "verification_failed" };
  }
  return { verdict: "passed", failureKind: null };
}

// Is there at least one commit on `branch` beyond `baseSha`? Empty output from
// rev-list means no new commit — the runner claimed done but committed nothing.
async function hasNewCommit(
  repoPath: string,
  baseSha: string,
  branch: string,
): Promise<{ has: boolean; tip: string }> {
  const tip = (
    await execFileAsync("git", ["-C", repoPath, "rev-parse", branch], { encoding: "utf8" })
  ).stdout.trim();
  const revs = (
    await execFileAsync("git", ["-C", repoPath, "rev-list", `${baseSha}..${branch}`], {
      encoding: "utf8",
    })
  ).stdout.trim();
  return { has: revs.length > 0, tip };
}

async function runCheck(
  check: Board["checks"][number],
  workDir: string,
  outDir: string,
  at: string,
): Promise<CheckResult> {
  const outputRef = `${outDir}/${check.key}.log`;
  let exitCode = 0;
  let output = "";
  try {
    const { stdout, stderr } = await execFileAsync(
      check.command[0],
      check.command.slice(1),
      { cwd: workDir, encoding: "utf8", timeout: check.timeoutMs, maxBuffer: CHECK_OUTPUT_CAP },
    );
    output = stdout + stderr;
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    exitCode = typeof e.code === "number" ? e.code : 1;
    output = `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}`;
  }
  await writeFile(outputRef, output.slice(-CHECK_OUTPUT_CAP));
  return { key: check.key, command: check.command, exitCode, outputRef, passedAt: at };
}

// Verify a finished execute run. Runs in the worktree; writes per-check logs
// under `<runDir>/checks/`. Returns the Evidence payload (minus ids/verdict
// wiring, which the supervisor stamps) plus the computed verdict.
export async function verifyRun(params: {
  repoPath: string;
  workDir: string;
  runDir: string;
  branch: string;
  baseSha: string;
  checks: Board["checks"];
  at: string;
}): Promise<{
  commitSha: string;
  commitRef: string;
  checks: CheckResult[];
  verdict: Verdict["verdict"];
  failureKind: Verdict["failureKind"];
}> {
  const { has, tip } = await hasNewCommit(params.repoPath, params.baseSha, params.branch);
  const outDir = `${params.runDir}/checks`;
  await mkdir(outDir, { recursive: true });
  const results: CheckResult[] = [];
  if (has) {
    for (const check of params.checks) {
      results.push(await runCheck(check, params.workDir, outDir, params.at));
    }
  }
  const { verdict, failureKind } = verdictFrom(has, results);
  return { commitSha: tip, commitRef: params.branch, checks: results, verdict, failureKind };
}
