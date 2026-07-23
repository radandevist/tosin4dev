import { describe, expect, it } from "vitest";
import {
  HandoffBriefSchema,
  InputExchangeSchema,
  RunOutcomeSchema,
} from "./schemas";

describe("HandoffBriefSchema", () => {
  it("defaults every field so a sparse brief still parses", () => {
    expect(HandoffBriefSchema.parse({})).toEqual({
      workDone: "",
      filesTouched: [],
      commandsRun: [],
      decision: "",
      options: [],
      risk: "",
    });
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

  it("rejects an unknown key", () => {
    expect(
      InputExchangeSchema.safeParse({
        v: 1,
        at: "2026-07-23T10:00:00.000Z",
        question: "q",
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it.each(["yesterday", ""])("rejects an invalid at value: %j", (at) => {
    expect(
      InputExchangeSchema.safeParse({ v: 1, at, question: "q" }).success,
    ).toBe(false);
  });

  it("rejects an invalid answeredAt value", () => {
    expect(
      InputExchangeSchema.safeParse({
        v: 1,
        at: "2026-07-23T10:00:00.000Z",
        question: "q",
        answeredAt: "nope",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty question", () => {
    expect(
      InputExchangeSchema.safeParse({
        v: 1,
        at: "2026-07-23T10:00:00.000Z",
        question: "",
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
