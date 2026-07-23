import { readFile } from "node:fs/promises";
import {
  HandoffBriefSchema,
  RunOutcomeSchema,
  type RunOutcome,
} from "../domain/schemas";

// Extract the provider session/thread id from a runner's structured stdout.
// claude --output-format json emits one JSON object carrying `session_id`;
// codex --json emits JSONL whose `thread.started` event carries `thread_id`.
// Returns null if not found (resume will then be unavailable — safe).
export function parseSessionId(
  runner: "claude" | "codex",
  stdout: string,
): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const rec = obj as Record<string, unknown>;
    if (runner === "claude" && typeof rec.session_id === "string") {
      return rec.session_id;
    }
    if (
      runner === "codex" &&
      rec.type === "thread.started" &&
      typeof rec.thread_id === "string"
    ) {
      return rec.thread_id;
    }
  }
  return null;
}

// Read + validate <runDir>/outcome.json. Fail-closed: a missing/invalid/absent
// file yields a `failed` outcome, so a runner that ignores the contract can
// never masquerade as completed.
export async function readOutcome(runDir: string): Promise<RunOutcome> {
  try {
    const raw = await readFile(`${runDir}/outcome.json`, "utf8");
    const decoded: unknown = JSON.parse(raw);
    const record =
      decoded !== null && typeof decoded === "object"
        ? (decoded as Record<string, unknown>)
        : null;
    // Fail-OPEN on the handoff only for needs_input: a malformed brief must
    // not downgrade an otherwise valid parked outcome to a failure. Handoffs
    // are discarded for every other outcome, so handoff !== null implies
    // outcome === "needs_input".
    const handoff =
      record?.outcome === "needs_input"
        ? HandoffBriefSchema.safeParse(record.handoff)
        : null;
    const parsed = RunOutcomeSchema.safeParse(
      record ? { ...record, handoff: null } : decoded,
    );
    if (!parsed.success) {
      return RunOutcomeSchema.parse({
        outcome: "failed",
        reason: "invalid outcome.json",
      });
    }
    return {
      ...parsed.data,
      handoff: handoff?.success ? handoff.data : null,
    };
  } catch {
    return RunOutcomeSchema.parse({
      outcome: "failed",
      reason: "no outcome.json written",
    });
  }
}
