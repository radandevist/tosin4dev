import { describe, expect, it } from "vitest";
import { parseChatResult, parseDraft } from "./chatResult";

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
