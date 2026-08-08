import { describe, expect, it } from "vitest";
import {
  decideFix,
  fixSignature,
  FIX_SIGNATURE_TAIL_BYTES,
  MAX_FIX_ATTEMPTS,
} from "./fix-loop";

const failing = [{ key: "lint", exitCode: 1, output: "error: unused var x" }];

describe("fixSignature", () => {
  it("is stable for identical failures", () => {
    expect(fixSignature(failing)).toBe(fixSignature([...failing]));
  });

  it("differs when a different check fails", () => {
    expect(fixSignature(failing)).not.toBe(
      fixSignature([{ key: "format", exitCode: 1, output: "error: unused var x" }]),
    );
  });

  it("differs when the exit code differs", () => {
    expect(fixSignature(failing)).not.toBe(
      fixSignature([{ key: "lint", exitCode: 2, output: "error: unused var x" }]),
    );
  });

  it("ignores a varying prefix beyond the tail window", () => {
    const tail = "the actual error";
    // A shared suffix longer than the window, so the entire variation lives in
    // the dropped prefix instead of bleeding into the kept tail (which is what
    // a prefix exactly FIX_SIGNATURE_TAIL_BYTES long would do).
    const shared = "x".repeat(FIX_SIGNATURE_TAIL_BYTES) + tail;
    const a = "A".repeat(8) + shared;
    const b = "B".repeat(8) + shared;
    expect(fixSignature([{ key: "lint", exitCode: 1, output: a }])).toBe(
      fixSignature([{ key: "lint", exitCode: 1, output: b }]),
    );
  });

  it("is order-independent across checks", () => {
    const one = { key: "lint", exitCode: 1, output: "a" };
    const two = { key: "format", exitCode: 1, output: "b" };
    expect(fixSignature([one, two])).toBe(fixSignature([two, one]));
  });
});

describe("decideFix", () => {
  const base = {
    failureKind: "verification_failed",
    attempts: 0,
    signature: "sig-a",
    lastSignature: null as string | null,
  };

  it("retries a first verification failure", () => {
    expect(decideFix(base)).toEqual({ retry: true });
  });

  it("does not retry no_commit", () => {
    expect(decideFix({ ...base, failureKind: "no_commit" })).toEqual({
      retry: false,
      reason: "not_retryable",
    });
  });

  it("does not retry a runner_exit failure", () => {
    expect(decideFix({ ...base, failureKind: "runner_exit" })).toEqual({
      retry: false,
      reason: "not_retryable",
    });
  });

  it("stops once the budget is exhausted", () => {
    expect(decideFix({ ...base, attempts: MAX_FIX_ATTEMPTS })).toEqual({
      retry: false,
      reason: "budget_exhausted",
    });
  });

  it("stops on a repeated signature even with budget left", () => {
    expect(
      decideFix({ ...base, attempts: 1, signature: "sig-a", lastSignature: "sig-a" }),
    ).toEqual({ retry: false, reason: "repeated_failure" });
  });

  it("retries when the signature changed and budget remains", () => {
    expect(
      decideFix({ ...base, attempts: 1, signature: "sig-b", lastSignature: "sig-a" }),
    ).toEqual({ retry: true });
  });

  it("prefers budget_exhausted over repeated_failure when both hold", () => {
    expect(
      decideFix({
        ...base,
        attempts: MAX_FIX_ATTEMPTS,
        signature: "sig-a",
        lastSignature: "sig-a",
      }),
    ).toEqual({ retry: false, reason: "budget_exhausted" });
  });
});
