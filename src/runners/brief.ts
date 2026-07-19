import type { RunnerBrief } from "./types";

export function buildPrompt(brief: RunnerBrief): string {
  const { ticket, board, workDir } = brief;
  const acceptance = ticket.spec.acceptance
    .map((criterion, index) => `${index + 1}. ${criterion}`)
    .join("\n");
  const links = ticket.spec.links.length
    ? ticket.spec.links.join("\n")
    : "none";

  if (brief.phase === "spec_draft") {
    return [
      `You are drafting the executable spec for ticket #${ticket.seq}: ${ticket.title}.`,
      `Repo: ${board.repoPath} (base branch: ${board.defaultBaseBranch}).`,
      `Intent: ${ticket.spec.intent}`,
      "Investigate the repo READ-ONLY and produce: a concrete plan, affected files, verification commands, and risks. Do not modify any file.",
      `Acceptance criteria:\n${acceptance || "none provided"}`,
      "End your output with a section titled SUMMARY containing at most 10 lines.",
    ].join("\n\n");
  }

  return [
    `Implement ticket #${ticket.seq}: ${ticket.title}.`,
    `Work directory (isolated git worktree): ${workDir}`,
    `Intent: ${ticket.spec.intent}`,
    `Scope (only touch these): ${ticket.spec.scope || "unspecified — stay minimal"}`,
    `Non-goals (must NOT change): ${ticket.spec.nonGoals || "none"}`,
    `Acceptance criteria:\n${acceptance || "none provided"}`,
    `Links:\n${links}`,
    "Rules: stay inside the worktree; run the repo's own verification commands; commit your changes on the current branch; do not push; do not open PRs.",
    "End your output with a section titled SUMMARY containing at most 10 lines including verification results.",
  ].join("\n\n");
}
