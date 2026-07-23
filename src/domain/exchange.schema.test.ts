import { describe, expect, it } from "vitest";
import {
  HandoffBriefSchema,
  InputExchangeSchema,
  RunOutcomeSchema,
} from "./schemas";

describe("HandoffBriefSchema", () => {
  it("defaults every field so a sparse brief still parses", () => {
    const brief = HandoffBriefSchema.parse({});
    expect(brief.workDone).toBe("");
    expect(brief.filesTouched).toEqual([]);
    expect(brief.options).toEqual([]);
  });

  it("rejects an unknown key", () => {
    expect(HandoffBriefSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
});

describe("InputExchangeSchema", () => {
  it("parses an open exchange", () => {
    const ex = InputExchangeSchema.parse({
      v: 1,
      at: "2026-07-23T10:00:00.000Z",
      question: "Which base branch?",
    });
    expect(ex.answer).toBeNull();
    expect(ex.answeredAt).toBeNull();
    expect(ex.handoff).toBeNull();
  });

  it("rejects a version other than 1", () => {
    expect(
      InputExchangeSchema.safeParse({
        v: 2,
        at: "2026-07-23T10:00:00.000Z",
        question: "q",
      }).success,
    ).toBe(false);
  });
});

describe("RunOutcomeSchema handoff (fail-OPEN)", () => {
  it("accepts needs_input with a handoff", () => {
    const o = RunOutcomeSchema.parse({
      outcome: "needs_input",
      question: "q",
      handoff: { workDone: "wired the parser", decision: "which branch" },
    });
    expect(o.handoff?.workDone).toBe("wired the parser");
  });

  it("defaults handoff to null when absent", () => {
    const o = RunOutcomeSchema.parse({ outcome: "needs_input", question: "q" });
    expect(o.handoff).toBeNull();
  });
});
