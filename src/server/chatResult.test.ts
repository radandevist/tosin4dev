import { describe, expect, it } from "vitest";
import { parseChatResult, parseDraft, parseTurn } from "./chatResult";

describe("parseChatResult", () => {
  it("extracts result text and session id from claude json", () => {
    const out = `{"type":"result","session_id":"s-1","result":"hi there"}`;
    expect(parseChatResult(out)).toEqual({ result: "hi there", sessionId: "s-1" });
  });
  it("returns null when there is no result field", () => {
    expect(parseChatResult(`{"session_id":"s-1"}`)).toBeNull();
    expect(parseChatResult("not json")).toBeNull();
  });
});

describe("parseTurn", () => {
  it("delegates claude output to parseChatResult", () => {
    const out = `{"type":"result","session_id":"s-1","result":"hi there"}`;
    expect(parseTurn("claude", out)).toEqual({
      result: "hi there",
      sessionId: "s-1",
    });
  });

  it("extracts the last codex agent message and skips error items", () => {
    const out = [
      `{"type":"thread.started","thread_id":"thread-1"}`,
      `{"type":"item.completed","item":{"id":"item-0","type":"error","message":"hooks warning"}}`,
      `{"type":"item.completed","item":{"id":"item-1","type":"agent_message","text":"first"}}`,
      `{"type":"item.completed","item":{"id":"item-2","type":"agent_message","text":"final answer"}}`,
    ].join("\n");
    expect(parseTurn("codex", out)).toEqual({
      result: "final answer",
      sessionId: "thread-1",
    });
  });

  it("returns null for codex output without an agent message", () => {
    const out = [
      `{"type":"thread.started","thread_id":"thread-1"}`,
      `{"type":"item.completed","item":{"type":"error","message":"failed"}}`,
    ].join("\n");
    expect(parseTurn("codex", out)).toBeNull();
    expect(parseTurn("codex", "not json")).toBeNull();
  });

  it("skips malformed JSON lines between valid codex events", () => {
    const out = [
      `{"type":"thread.started","thread_id":"thread-1"}`,
      `{"type": this is malformed JSON`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"survived"}}`,
    ].join("\n");
    expect(parseTurn("codex", out)).toEqual({
      result: "survived",
      sessionId: "thread-1",
    });
  });

  it("fails closed when a codex agent message has no string text", () => {
    const missing = `{"type":"item.completed","item":{"type":"agent_message"}}`;
    const nonString = `{"type":"item.completed","item":{"type":"agent_message","text":42}}`;
    expect(parseTurn("codex", missing)).toBeNull();
    expect(parseTurn("codex", nonString)).toBeNull();
  });
});

describe("parseDraft", () => {
  const valid = JSON.stringify({
    title: "Add login", type: "implement", runner: "claude",
    spec: { intent: "add", scope: "", nonGoals: "", acceptance: [], links: [], risk: "low" },
  });
  it("parses a valid draft, including fenced json", () => {
    expect(parseDraft(valid)?.title).toBe("Add login");
    expect(parseDraft("```json\n" + valid + "\n```")?.title).toBe("Add login");
  });
  it("returns null on prose or invalid draft (fail-closed)", () => {
    expect(parseDraft("here is your spec!")).toBeNull();
    expect(parseDraft(`{"title":"x"}`)).toBeNull();
  });
});
