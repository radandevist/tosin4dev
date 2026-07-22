import { describe, expect, it } from "vitest";
import { buildChatCommand } from "./chatCommand";

describe("buildChatCommand", () => {
  it("builds a fresh turn without --resume", () => {
    expect(buildChatCommand("hello", null)).toEqual([
      "claude", "-p", "hello", "--output-format", "json",
    ]);
  });
  it("appends --resume with a captured session id", () => {
    expect(buildChatCommand("more", "sess-1")).toEqual([
      "claude", "-p", "more", "--output-format", "json", "--resume", "sess-1",
    ]);
  });
});
