import type { z } from "zod";
import { TicketStatus } from "./schemas";

// The ticket lifecycle status, sourced from the single Zod enum in schemas.ts
// so the machine can never drift from the persisted vocabulary. `import type`
// keeps `z` out of the runtime bundle — it is used purely for the inference.
type Status = z.infer<typeof TicketStatus>;

// The two — and only two — states that wait on a human decision: spec approval
// and final review. Everything else is driven by the supervisor or the machine.
export const HUMAN_GATES: readonly Status[] = ["spec_review", "review_ready"];

// The set of events the machine understands. `archive` is intentionally absent
// from the table below because it is unconditional (see `transition`).
export type Event =
  | "submit_spec"
  | "approve_spec"
  | "request_spec_changes"
  | "dispatch"
  | "run_succeeded"
  | "run_failed"
  | "resume"
  | "approve_final"
  | "request_changes"
  | "archive";

// `${from}:${event}` -> next status. The smallest clear representation of the
// legal edges; any pair absent here is an invalid transition.
const TABLE: Record<string, Status> = {
  "inbox:submit_spec": "spec_review",
  "spec_review:approve_spec": "approved",
  "spec_review:request_spec_changes": "inbox",
  "approved:dispatch": "running",
  "running:run_succeeded": "review_ready",
  "running:run_failed": "blocked",
  "blocked:resume": "approved",
  "review_ready:approve_final": "done",
  // request_changes re-enters `running`; the supervisor dispatches the
  // review_fix run — no orchestration lives in the machine.
  "review_ready:request_changes": "running",
};

export function transition(from: Status, event: Event): Status {
  // Archive is reachable from anywhere and is idempotent from terminal states.
  if (event === "archive") return "archived";
  const to = TABLE[`${from}:${event}`];
  if (!to) throw new Error(`invalid transition: ${from} + ${event}`);
  return to;
}
