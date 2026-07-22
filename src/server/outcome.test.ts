import { describe, expect, it } from "vitest";
import { parseSessionId } from "./outcome.server";

describe("parseSessionId", () => {
  it("reads session_id from a claude json result within multiline stdout", () => {
    const jsonl = [
      '{"type":"system","message":"starting"}',
      '{"type":"result","session_id":"abc-123","result":"ok"}',
    ].join("\n");

    expect(parseSessionId("claude", jsonl)).toBe("abc-123");
  });

  it("reads thread_id from codex thread.started event", () => {
    const jsonl =
      '{"type":"thread.started","thread_id":"019f-xyz"}\n{"type":"turn.completed"}';
    expect(parseSessionId("codex", jsonl)).toBe("019f-xyz");
  });

  it("returns null when absent or unparseable", () => {
    expect(parseSessionId("claude", "not json")).toBeNull();
    expect(parseSessionId("codex", "{}")).toBeNull();
  });
});
