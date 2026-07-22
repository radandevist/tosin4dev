// The argv for one brainstorm turn. Unlike the run adapter (which points the
// agent at a prompt file), a chat turn passes the user's text directly and
// resumes the captured provider session so context carries across turns.
export function buildChatCommand(
  text: string,
  sessionId: string | null,
): string[] {
  const cmd = ["claude", "-p", text, "--output-format", "json"];
  if (sessionId) cmd.push("--resume", sessionId);
  return cmd;
}
