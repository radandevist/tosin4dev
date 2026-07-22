import { describe, expect, it } from "vitest";
import { isChatTurnPending } from "./chatUi";

describe("isChatTurnPending", () => {
  it("polls only while a turn is pending", () => {
    expect(isChatTurnPending("pending")).toBe(true);
    expect(isChatTurnPending("idle")).toBe(false);
    expect(isChatTurnPending("error")).toBe(false);
  });
});
