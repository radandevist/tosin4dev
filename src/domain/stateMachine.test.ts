import { describe, it, expect } from "vitest";
import { transition, HUMAN_GATES } from "./stateMachine";

describe("transition", () => {
  it("walks the happy path", () => {
    expect(transition("inbox", "submit_spec")).toBe("spec_review");
    expect(transition("spec_review", "approve_spec")).toBe("approved");
    expect(transition("approved", "dispatch")).toBe("running");
    expect(transition("running", "run_succeeded")).toBe("review_ready");
    expect(transition("review_ready", "approve_final")).toBe("done");
  });

  it("rejects invalid transitions", () => {
    expect(() => transition("inbox", "dispatch")).toThrow(/invalid/i);
    expect(() => transition("running", "approve_spec")).toThrow();
    expect(() => transition("done", "dispatch")).toThrow();
  });

  it("routes failures to blocked and resumes to approved", () => {
    expect(transition("running", "run_failed")).toBe("blocked");
    expect(transition("blocked", "resume")).toBe("approved");
  });

  it("review changes re-enter running via review_fix", () => {
    // The supervisor is responsible for dispatching the review_fix run; the
    // machine only moves the ticket back into `running`.
    expect(transition("review_ready", "request_changes")).toBe("running");
  });

  it("spec rejection returns to inbox", () => {
    expect(transition("spec_review", "request_spec_changes")).toBe("inbox");
  });

  it("archive is reachable from every live state", () => {
    for (const s of [
      "inbox",
      "spec_review",
      "approved",
      "running",
      "blocked",
      "review_ready",
    ] as const) {
      expect(transition(s, "archive")).toBe("archived");
    }
  });

  it("archive is idempotent from terminal states", () => {
    // Clarifies that archive is unconditional: done and archived also archive.
    expect(transition("done", "archive")).toBe("archived");
    expect(transition("archived", "archive")).toBe("archived");
  });

  it("rejects an unknown event", () => {
    expect(() => transition("inbox", "frobnicate" as never)).toThrow(/invalid/i);
  });

  it("exposes exactly two human gates", () => {
    expect(HUMAN_GATES).toEqual(["spec_review", "review_ready"]);
  });
});
