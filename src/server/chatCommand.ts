// The argv for one brainstorm turn. Unlike the run adapter (which points the
// agent at a prompt file), a chat turn passes the user's text directly and
// resumes the captured provider session so context carries across turns.
export function buildChatCommand(
  text: string,
  sessionId: string | null,
  provider: "claude" | "codex",
  repoPath: string,
): string[] {
  if (provider === "codex") {
    const root = ["codex", "-C", repoPath, "-s", "read-only", "exec"];
    const resume = sessionId ? ["resume", sessionId] : [];
    return [...root, ...resume, "--json", text];
  }
  const cmd = ["claude", "-p", text, "--output-format", "json"];
  if (sessionId) cmd.push("--resume", sessionId);
  return cmd;
}
