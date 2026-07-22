import { z } from "zod";
import { TicketStatus } from "./schemas";

// The ticket lifecycle status, sourced from the single Zod enum in schemas.ts
// so the machine can never drift from the persisted vocabulary.
type Status = z.infer<typeof TicketStatus>;

// The states that wait on a human decision: spec approval, final review, or a
// question raised by an active run. Everything else is supervisor/machine-driven.
export const HUMAN_GATES: readonly Status[] = [
  "spec_review",
  "review_ready",
  "needs_input",
];

// The set of events the machine understands, expressed as a Zod enum so server
// boundaries can validate an incoming event with `EventSchema.parse(...)` rather
// than a bare `z.string()` + cast. `archive` is intentionally still listed here
// (it is a real event) but is absent from the table below because it is
// unconditional (see `transition`).
export const EventSchema = z.enum([
  "submit_spec",
  "approve_spec",
  "request_spec_changes",
  "dispatch",
  "run_succeeded",
  "run_failed",
  "run_needs_input",
  "provide_input",
  "resume",
  "approve_final",
  "request_changes",
  "archive",
]);
export type Event = z.infer<typeof EventSchema>;

// The subset of events a human may trigger from the UI. Derived from
// `EventSchema` (never hand-listed) by excluding the machine/supervisor events
// so a browser can request a spec submit/approval, provide input, resume, approve
// final changes, or archive, but can never forge a run outcome or a dispatch.
// The server boundary
// (`transitionTicket`) validates its `event` input against this, while the
// supervisor keeps calling `transition` with the full `Event` vocabulary.
export const PublicEventSchema = EventSchema.exclude([
  "dispatch",
  "run_succeeded",
  "run_failed",
  "run_needs_input",
]);
export type PublicEvent = z.infer<typeof PublicEventSchema>;

// The only keys the table may hold: a legal `${status}:${event}` string for
// every non-archive event. Typing TABLE against this union makes a misspelled
// status or event key a compile error, while `Partial` still lets us omit the
// invalid transitions (their absence is what makes them invalid).
type TransitionKey = `${Status}:${Exclude<Event, "archive">}`;

// `${from}:${event}` -> next status. The smallest clear representation of the
// legal edges; any pair absent here is an invalid transition.
const TABLE: Partial<Record<TransitionKey, Status>> = {
  "inbox:submit_spec": "spec_review",
  "spec_review:approve_spec": "approved",
  "spec_review:request_spec_changes": "inbox",
  "approved:dispatch": "running",
  "running:run_succeeded": "review_ready",
  "running:run_failed": "blocked",
  "running:run_needs_input": "needs_input",
  "needs_input:provide_input": "running",
  "blocked:resume": "approved",
  "review_ready:approve_final": "done",
  // request_changes re-enters `running`; the supervisor dispatches the
  // review_fix run — no orchestration lives in the machine.
  "review_ready:request_changes": "running",
};

export function transition(from: Status, event: Event): Status {
  // Archive is reachable from anywhere and is idempotent from terminal states.
  if (event === "archive") return "archived";
  // `event` is now narrowed to `Exclude<Event, "archive">`, so the key matches
  // `TransitionKey` exactly — no cast needed.
  const to = TABLE[`${from}:${event}`];
  if (!to) throw new Error(`invalid transition: ${from} + ${event}`);
  return to;
}
