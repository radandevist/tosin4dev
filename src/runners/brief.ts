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

  const resumePreface = brief.resume
    ? `You previously paused to ask a question. The human answered:\n${brief.resume.answer}\nContinue from where you left off under the SAME locked spec.`
    : null;
  const lines = [
    `Implement ticket #${ticket.seq}: ${ticket.title}.`,
    `Work directory (isolated git worktree): ${workDir}`,
    `Intent: ${ticket.spec.intent}`,
    `Scope (only touch these): ${ticket.spec.scope || "unspecified — stay minimal"}`,
    `Non-goals (must NOT change): ${ticket.spec.nonGoals || "none"}`,
    `Acceptance criteria:\n${acceptance || "none provided"}`,
    `Links:\n${links}`,
    "Rules: stay inside the worktree; run the repo's own verification commands; commit your changes on the current branch; do not push; do not open PRs.",
    `When you finish, write this JSON to ${brief.outcomePath ?? "<runDir>/outcome.json"} and nothing else to it:`,
    `{"outcome":"completed|needs_input|failed","question":"<required if needs_input>","reason":"<optional>","summary":"<=10 lines"}`,
    `Use "needs_input" ONLY for a genuine decision you cannot make under the locked spec; put the exact question in "question". Use "completed" when the work is done and committed; "failed" if you cannot proceed. Do not ask for confirmation of work you can just do.`,
  ];
  return [resumePreface, ...lines].filter(Boolean).join("\n\n");
}
