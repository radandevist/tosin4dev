import { describe, expect, it } from "vitest";
import { buildChatCommand } from "./chatCommand";

describe("buildChatCommand", () => {
  it("builds a fresh claude turn without --resume", () => {
    expect(buildChatCommand("hello", null, "claude", "/repo")).toEqual([
      "claude", "-p", "hello", "--output-format", "json",
    ]);
  });
  it("appends --resume to a claude turn with a captured session id", () => {
    expect(buildChatCommand("more", "sess-1", "claude", "/repo")).toEqual([
      "claude", "-p", "more", "--output-format", "json", "--resume", "sess-1",
    ]);
  });

  it("builds a fresh codex exec turn", () => {
    expect(buildChatCommand("hello", null, "codex", "/repo")).toEqual([
      "codex", "-C", "/repo", "-s", "read-only", "exec", "--json", "hello",
    ]);
  });

  it("resumes a codex exec turn with a captured session id", () => {
    expect(buildChatCommand("more", "thread-1", "codex", "/repo")).toEqual([
      "codex", "-C", "/repo", "-s", "read-only", "exec", "resume", "thread-1", "--json", "more",
    ]);
  });
});
