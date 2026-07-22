import { describe, expect, it } from "vitest";
import {
  ChatDraftSchema,
  ChatMessageSchema,
  ChatSessionSchema,
  ChatTurnStatus,
} from "./schemas";

describe("chat schemas", () => {
  it("accepts a minimal chat session and applies defaults", () => {
    const s = ChatSessionSchema.parse({
      boardId: "507f1f77bcf86cd799439011",
    });
    expect(s.provider).toBe("claude");
    expect(s.sessionId).toBeNull();
    expect(s.status).toBe("active");
    expect(s.turnStatus).toBe("idle");
    expect(s.turnError).toBeNull();
    expect(s.messages).toEqual([]);
    expect(s.bundleId).toBeNull();
    expect(s).not.toHaveProperty("proposedSpec");
    expect(s).not.toHaveProperty("ticketId");
  });

  it("validates message role + turn status enum", () => {
    expect(() =>
      ChatMessageSchema.parse({ role: "user", text: "hi", at: new Date().toISOString() }),
    ).not.toThrow();
    expect(() => ChatMessageSchema.parse({ role: "system", text: "x", at: new Date().toISOString() })).toThrow();
    expect(ChatTurnStatus.options).toEqual(["idle", "pending", "error"]);
  });

  it("accepts a well-formed draft and rejects a malformed one (fail-closed)", () => {
    const draft = ChatDraftSchema.parse({
      title: "Add auth",
      type: "implement",
      runner: "claude",
      spec: { intent: "add login", scope: "", nonGoals: "", acceptance: [], links: [], risk: "low" },
    });
    expect(draft.title).toBe("Add auth");
    // missing intent → invalid
    expect(() =>
      ChatDraftSchema.parse({ title: "x", type: "implement", runner: "claude", spec: { scope: "", nonGoals: "", acceptance: [], links: [], risk: "low" } }),
    ).toThrow();
    // unknown top-level key → rejected (strict)
    expect(() =>
      ChatDraftSchema.parse({ title: "x", type: "implement", runner: "claude", spec: { intent: "y", scope: "", nonGoals: "", acceptance: [], links: [], risk: "low" }, extra: 1 }),
    ).toThrow();
  });
});
