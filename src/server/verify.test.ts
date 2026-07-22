import { describe, expect, it } from "vitest";
import { verdictFrom } from "./verify.server";

describe("verdictFrom", () => {
  it("fails when there is no new commit", () => {
    expect(verdictFrom(false, [])).toEqual({ verdict: "failed", failureKind: "no_commit" });
  });
  it("fails when any check is nonzero", () => {
    expect(
      verdictFrom(true, [{ key: "t", command: [], exitCode: 1, outputRef: "x", passedAt: "t" }]),
    ).toEqual({ verdict: "failed", failureKind: "verification_failed" });
  });
  it("passes with a commit and all checks zero", () => {
    expect(
      verdictFrom(true, [{ key: "t", command: [], exitCode: 0, outputRef: "x", passedAt: "t" }]),
    ).toEqual({ verdict: "passed", failureKind: null });
  });
  it("passes with a commit and no checks configured", () => {
    expect(verdictFrom(true, [])).toEqual({ verdict: "passed", failureKind: null });
  });
});
