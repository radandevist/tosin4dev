// The argv for one chat turn. Unlike the run adapter (which points the
// agent at a prompt file), a chat turn passes the user's text directly and
// resumes the captured provider session so context carries across turns.
export function buildChatCommand(
  text: string,
  sessionId: string | null,
  provider: "claude" | "codex",
  repoPath: string,
  kind: "brainstorm" | "consultation",
): string[] {
  if (provider === "codex") {
    // codex read-only still permits file reads; unlike claude we cannot disable
    // Read here, so a codex consultant can read (and thus echo) on-disk run
    // artifacts — residual accepted, flagged for owner.
    const root = ["codex", "-C", repoPath, "-s", "read-only", "exec"];
    const resume = sessionId ? ["resume", sessionId] : [];
    return [...root, ...resume, "--json", text];
  }
  const cmd = ["claude", "-p", text, "--output-format", "json"];
  // Verified locally on 2026-07-23: `claude --help` exposes the variadic
  // `--disallowedTools` flag.
  if (kind === "consultation") {
    cmd.push(
      "--disallowedTools",
      "Edit",
      "Write",
      "NotebookEdit",
      "Bash",
      "Read",
      "Grep",
      "Glob",
      "WebFetch",
      "WebSearch",
    );
  }
  if (sessionId) cmd.push("--resume", sessionId);
  return cmd;
}
