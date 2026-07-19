import { useQueryClient } from "@tanstack/react-query";
import type { TicketDTO, TransitionInput } from "../server/tickets";
import { useTicket, useTickets, useTransition } from "../queries/tickets";
import type { TicketStatus } from "./TicketCard";

// The public gate a human may trigger from a given status. `event` is typed as
// the transition input's event field, so a typo here is a compile error and the
// browser can only ever request one of the domain's public events.
type GateEvent = TransitionInput["event"];
export type Gate = {
  event: GateEvent;
  label: string;
  tone: "primary" | "default";
};

// The valid human gates for each status, matching the domain state machine's
// human-triggerable edges exactly. Only the four statuses that wait on a person
// expose buttons; `approved` shows an explanatory line (see GateButtons), and
// every other status returns none. Pure and exported for unit testing against
// the domain `transition` table.
export function gatesForStatus(status: TicketStatus): Gate[] {
  switch (status) {
    case "inbox":
      return [
        { event: "submit_spec", label: "Submit for spec review", tone: "primary" },
      ];
    case "spec_review":
      return [
        { event: "approve_spec", label: "Approve spec", tone: "primary" },
        {
          event: "request_spec_changes",
          label: "Request changes",
          tone: "default",
        },
      ];
    case "blocked":
      return [{ event: "resume", label: "Resume", tone: "primary" }];
    case "review_ready":
      return [
        { event: "approve_final", label: "Final approve", tone: "primary" },
        { event: "request_changes", label: "Request changes", tone: "default" },
      ];
    default:
      return [];
  }
}

const TONE_CLASS: Record<Gate["tone"], string> = {
  primary:
    "bg-zinc-900 text-white hover:bg-zinc-800 focus-visible:outline-zinc-900",
  default:
    "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 focus-visible:outline-zinc-900",
};

export function GateButtons({ ticket }: { ticket: TicketDTO }) {
  const queryClient = useQueryClient();
  const transition = useTransition();
  const gates = gatesForStatus(ticket.status);

  // A gate moves the ticket, so both the ticket detail and its board list are
  // now stale. Invalidate exactly those two cache entries by their typed keys.
  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: useTicket.getKey({ boardId: ticket.boardId, seq: ticket.seq }),
    });
    queryClient.invalidateQueries({
      queryKey: useTickets.getKey({ boardId: ticket.boardId }),
    });
  };

  if (ticket.status === "approved") {
    return (
      <p className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
        Ready to run — the supervisor will dispatch this ticket to its runner.
      </p>
    );
  }

  if (gates.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {gates.map((gate) => {
          const pending =
            transition.isPending && transition.variables?.event === gate.event;
          return (
            <button
              key={gate.event}
              type="button"
              disabled={transition.isPending}
              onClick={() =>
                transition.mutate(
                  { ticketId: ticket._id, event: gate.event },
                  { onSuccess: invalidate },
                )
              }
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${TONE_CLASS[gate.tone]}`}
            >
              {pending ? "Working…" : gate.label}
            </button>
          );
        })}
      </div>
      {transition.isError ? (
        <p role="alert" className="text-sm text-rose-600">
          {transition.error.message}
        </p>
      ) : null}
    </div>
  );
}
