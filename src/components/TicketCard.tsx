import { Link } from "@tanstack/react-router";
import type { TicketDTO } from "../server/tickets";

// Presentation vocabulary derived from the DTO itself, so the labels can never
// drift from the persisted enums. Adapted (not imported) from the gray-ui-csm
// reference: restrained zinc palette, rounded cards, compact metadata.
export type TicketStatus = TicketDTO["status"];
type TicketType = TicketDTO["type"];
type Runner = TicketDTO["runner"];
type Risk = TicketDTO["spec"]["risk"];

export const STATUS_LABELS: Record<TicketStatus, string> = {
  inbox: "Inbox",
  spec_review: "Spec Review",
  approved: "Approved",
  running: "Running",
  needs_input: "Needs Input",
  blocked: "Blocked",
  review_ready: "Review Ready",
  done: "Done",
  archived: "Archived",
};

export const TYPE_LABELS: Record<TicketType, string> = {
  research: "Research",
  spec: "Spec",
  implement: "Implement",
  bugfix: "Bugfix",
  review: "Review",
};

export const RISK_LABELS: Record<Risk, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

// The eight columns the board shows, in lifecycle order. `archived` is
// intentionally excluded — it is a terminal side state, not a board column.
export const BOARD_COLUMNS: readonly { key: TicketStatus; label: string }[] = [
  { key: "inbox", label: STATUS_LABELS.inbox },
  { key: "spec_review", label: STATUS_LABELS.spec_review },
  { key: "approved", label: STATUS_LABELS.approved },
  { key: "running", label: STATUS_LABELS.running },
  { key: "needs_input", label: STATUS_LABELS.needs_input },
  { key: "blocked", label: STATUS_LABELS.blocked },
  { key: "review_ready", label: STATUS_LABELS.review_ready },
  { key: "done", label: STATUS_LABELS.done },
];

const RISK_DOT: Record<Risk, string> = {
  low: "bg-emerald-500",
  medium: "bg-amber-500",
  high: "bg-rose-500",
};

const RUNNER_LABELS: Record<Runner, string> = {
  claude: "Claude",
  codex: "Codex",
};

export function RiskLabel({ risk }: { risk: Risk }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${RISK_DOT[risk]}`}
      />
      <span>{RISK_LABELS[risk]}</span>
    </>
  );
}

// Group a board's tickets into its eight columns. Pure and exported so it can be
// unit-tested and reused without pulling in React. Tickets whose status is not a
// board column (e.g. `archived`) are dropped from the board view.
export function groupTicketsByStatus(
  tickets: readonly TicketDTO[],
): Record<TicketStatus, TicketDTO[]> {
  const groups = {
    inbox: [],
    spec_review: [],
    approved: [],
    running: [],
    needs_input: [],
    blocked: [],
    review_ready: [],
    done: [],
    archived: [],
  } as Record<TicketStatus, TicketDTO[]>;
  for (const ticket of tickets) groups[ticket.status].push(ticket);
  return groups;
}

export function TicketCard({
  ticket,
  boardSlug,
}: {
  ticket: TicketDTO;
  boardSlug: string;
}) {
  return (
    <Link
      to="/b/$boardSlug/t/$ticketSeq"
      params={{ boardSlug, ticketSeq: String(ticket.seq) }}
      className="block rounded-xl border border-zinc-200 bg-white p-3 shadow-sm transition-colors hover:border-zinc-300 hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-zinc-600 uppercase">
          {TYPE_LABELS[ticket.type]}
        </span>
        <span className="font-mono text-xs text-zinc-400">#{ticket.seq}</span>
      </div>

      <p className="mt-2 line-clamp-2 text-sm leading-6 font-medium text-zinc-900">
        {ticket.title}
      </p>

      {ticket.dependsOn.length > 0 ? (
        <p className="mt-2 text-xs text-zinc-400">
          depends on: {ticket.dependsOn.map((id) => `#${id}`).join(", ")}
        </p>
      ) : null}

      <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
        <span className="inline-flex items-center gap-1.5">
          <RiskLabel risk={ticket.spec.risk} />
          <span aria-hidden="true">·</span>
          {RUNNER_LABELS[ticket.runner]}
        </span>
        {ticket.prUrl ? (
          <span className="font-medium text-zinc-600">PR</span>
        ) : null}
      </div>
    </Link>
  );
}
