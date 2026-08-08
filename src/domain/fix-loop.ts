import { createHash } from "node:crypto";

// Two attempts, not more. Every attempt costs tokens the owner pays for, and an
// agent that has failed the same checks twice is not one prompt from success.
export const MAX_FIX_ATTEMPTS = 2;

// Only the tail of a check's output enters the signature. A varying prefix
// (timings, absolute paths, progress spinners) would otherwise make two
// identical failures hash differently and defeat the repeat guard entirely.
export const FIX_SIGNATURE_TAIL_BYTES = 2048;

export type FixDecision =
  | { retry: true }
  | {
      retry: false;
      reason: "budget_exhausted" | "repeated_failure" | "not_retryable";
    };

// A stable fingerprint of "which checks failed and how". Sorted by key so two
// runs that fail the same checks in a different order hash the same.
export function fixSignature(
  checks: { key: string; exitCode: number; output: string }[],
): string {
  const hash = createHash("sha256");
  for (const check of [...checks].sort((a, b) => a.key.localeCompare(b.key))) {
    // NUL separators: a check key can't contain "\0", so {key:"a1",exit:1}
    // and {key:"a",exit:11} no longer feed the same "a11" bytes, and the
    // trailing separator keeps adjacent checks from running together.
    hash.update(`${check.key}\0${check.exitCode}\0`);
    hash.update(check.output.slice(-FIX_SIGNATURE_TAIL_BYTES));
    hash.update("\0");
  }
  return hash.digest("hex");
}

// Should a failed verification be handed back to the agent?
//
// Order matters. Budget is checked before the repeat guard so that exhausting
// the budget on a repeated failure reports the budget — the owner-facing
// message differs, and "you spent everything" is the more actionable of the two.
export function decideFix(input: {
  failureKind: string | null;
  attempts: number;
  signature: string;
  lastSignature: string | null;
}): FixDecision {
  // Only a failed acceptance check is worth another prompt. An agent that
  // committed nothing, or whose process exited nonzero, has a different problem
  // and re-prompting it burns twenty minutes to arrive in the same place.
  if (input.failureKind !== "verification_failed") {
    return { retry: false, reason: "not_retryable" };
  }
  if (input.attempts >= MAX_FIX_ATTEMPTS) {
    return { retry: false, reason: "budget_exhausted" };
  }
  if (input.lastSignature !== null && input.lastSignature === input.signature) {
    return { retry: false, reason: "repeated_failure" };
  }
  return { retry: true };
}
