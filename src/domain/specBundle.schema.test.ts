import { describe, expect, it } from "vitest";
import {
  BundleMemberSchema,
  SpecBundleProposalSchema,
  SpecBundleSchema,
  TicketSchema,
} from "./schemas";

const member = {
  localKey: "t1",
  title: "Add auth",
  type: "implement",
  runner: "claude",
  spec: {
    intent: "login",
    scope: "",
    nonGoals: "",
    acceptance: [],
    links: [],
    risk: "low",
  },
  dependsOn: [],
};

describe("spec bundle schemas", () => {
  it("accepts a member and defaults dependsOn to []", () => {
    const m = BundleMemberSchema.parse({ ...member, dependsOn: undefined });
    expect(m.dependsOn).toEqual([]);
  });
  it("rejects a member with an unknown top-level key (strict)", () => {
    expect(() => BundleMemberSchema.parse({ ...member, extra: 1 })).toThrow();
  });
  it("accepts a proposal of rationale + members", () => {
    const p = SpecBundleProposalSchema.parse({
      rationale: "split by concern",
      members: [member],
    });
    expect(p.members).toHaveLength(1);
  });
  it("accepts a persisted bundle and defaults lockedTicketIds to null", () => {
    const b = SpecBundleSchema.parse({
      sessionId: "507f1f77bcf86cd799439011",
      boardId: "507f1f77bcf86cd799439012",
      status: "drafting",
      rationale: "r",
      members: [member],
    });
    expect(b.lockedTicketIds).toBeNull();
    expect(b.status).toBe("drafting");
  });
  it("Ticket defaults dependsOn to []", () => {
    const t = TicketSchema.parse({
      boardId: "507f1f77bcf86cd799439012",
      seq: 1,
      title: "x",
      type: "implement",
      status: "inbox",
      runner: "claude",
      spec: { intent: "y" },
    });
    expect(t.dependsOn).toEqual([]);
  });
});
