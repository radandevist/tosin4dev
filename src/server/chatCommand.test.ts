import { describe, expect, it } from "vitest";
import { buildChatCommand } from "./chatCommand";

describe("buildChatCommand", () => {
  it("builds a fresh claude turn without --resume", () => {
    expect(buildChatCommand("hello", null, "claude", "/repo", "brainstorm")).toEqual([
      "claude", "-p", "hello", "--output-format", "json",
    ]);
  });
  it("appends --resume to a claude turn with a captured session id", () => {
    expect(buildChatCommand("more", "sess-1", "claude", "/repo", "brainstorm")).toEqual([
      "claude", "-p", "more", "--output-format", "json", "--resume", "sess-1",
    ]);
  });

  it("builds a fresh codex exec turn", () => {
    expect(buildChatCommand("hello", null, "codex", "/repo", "brainstorm")).toEqual([
      "codex", "-C", "/repo", "-s", "read-only", "exec", "--json", "hello",
    ]);
  });

  it("resumes a codex exec turn with a captured session id", () => {
    expect(buildChatCommand("more", "thread-1", "codex", "/repo", "brainstorm")).toEqual([
      "codex", "-C", "/repo", "-s", "read-only", "exec", "resume", "thread-1", "--json", "more",
    ]);
  });

  it("disallows mutation tools for a claude consultation", () => {
    expect(
      buildChatCommand("help", null, "claude", "/run/consult", "consultation"),
    ).toEqual([
      "claude",
      "-p",
      "help",
      "--output-format",
      "json",
      "--disallowedTools",
      "Edit",
      "Write",
      "NotebookEdit",
      "Bash",
    ]);
  });

  it("keeps codex consultations read-only in the scratch directory", () => {
    expect(
      buildChatCommand("help", null, "codex", "/run/consult", "consultation"),
    ).toEqual([
      "codex",
      "-C",
      "/run/consult",
      "-s",
      "read-only",
      "exec",
      "--json",
      "help",
    ]);
  });
});
