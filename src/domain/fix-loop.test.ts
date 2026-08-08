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
    // A distinct object literal, not a shallow copy: this pins value-based
    // stability — the property that matters across two separate runs.
    expect(fixSignature(failing)).toBe(
      fixSignature([{ key: "lint", exitCode: 1, output: "error: unused var x" }]),
    );
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

  it("differs when only the output differs", () => {
    expect(fixSignature([{ key: "lint", exitCode: 1, output: "error A" }])).not.toBe(
      fixSignature([{ key: "lint", exitCode: 1, output: "error B" }]),
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

  it("distinguishes a digit-ending key from a longer exit code", () => {
    // Without a delimiter {key:"a1",exitCode:1} and {key:"a",exitCode:11}
    // both feed "a11"; keys may contain digits, so this is reachable.
    expect(
      fixSignature([{ key: "a1", exitCode: 1, output: "x" }]),
    ).not.toBe(
      fixSignature([{ key: "a", exitCode: 11, output: "x" }]),
    );
  });

  it("distinguishes two adjacent checks from one longer check", () => {
    // Without a trailing separator, [{key:"a",exitCode:1,output:"b"},
    // {key:"c",exitCode:1,output:"d"}] and [{key:"a",exitCode:1,
    // output:"bc1d"}] both feed "a1bc1d".
    expect(
      fixSignature([
        { key: "a", exitCode: 1, output: "b" },
        { key: "c", exitCode: 1, output: "d" },
      ]),
    ).not.toBe(
      fixSignature([{ key: "a", exitCode: 1, output: "bc1d" }]),
    );
  });

  it("drops a differing byte just before the tail window and keeps one at its edge", () => {
    // N = FIX_SIGNATURE_TAIL_BYTES. The slice keeps the last N chars of an
    // output of length L, i.e. indices L-N..L-1. With L = N+2 those are
    // indices 2..N+1, so a differing char at index 1 (= L-N-1) is DROPPED
    // and one at index 2 (= L-N) is the first KEPT char. An off-by-one in
    // the slice lands on one of these two and fails one assertion.
    const ignored = (c: string) => `x${c}${"x".repeat(FIX_SIGNATURE_TAIL_BYTES)}`;
    const kept = (c: string) => `xx${c}${"x".repeat(FIX_SIGNATURE_TAIL_BYTES - 1)}`;
    expect(
      fixSignature([{ key: "lint", exitCode: 1, output: ignored("A") }]),
    ).toBe(
      fixSignature([{ key: "lint", exitCode: 1, output: ignored("B") }]),
    );
    expect(
      fixSignature([{ key: "lint", exitCode: 1, output: kept("A") }]),
    ).not.toBe(
      fixSignature([{ key: "lint", exitCode: 1, output: kept("B") }]),
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
