import type { InputExchange } from "../domain/schemas";
import type { RunDTO } from "../server/runs";
import type { TicketDTO } from "../server/tickets";

type DispatchAction = {
  label: string;
  phase: "spec_draft" | "execute";
};

const RUNNER_LABELS: Record<TicketDTO["runner"], string> = {
  claude: "Claude",
  codex: "Codex",
};

export function dispatchActionForTicket(
  status: TicketDTO["status"],
  runner: TicketDTO["runner"],
  activeRunId: TicketDTO["activeRunId"],
): DispatchAction | null {
  if (activeRunId !== null) return null;
  if (status === "inbox") {
    return {
      label: `Draft spec with ${RUNNER_LABELS[runner]}`,
      phase: "spec_draft",
    };
  }
  if (status === "approved") {
    return { label: "Run now", phase: "execute" };
  }
  return null;
}

export function isLiveRunStatus(status: RunDTO["status"]): boolean {
  return status === "queued" || status === "running";
}

export function isTerminalRunStatus(status: RunDTO["status"]): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "blocked" ||
    status === "cancelled"
  );
}

export function shouldPollRun(status: RunDTO["status"]): boolean {
  return status === "queued" || status === "running" || status === "verifying";
}

export function isTicketAdvancingRunStatus(
  status: RunDTO["status"],
): boolean {
  return isTerminalRunStatus(status) || status === "awaiting_input";
}

export function shouldPollLog(
  openRunId: string | null,
  selectedStatus: RunDTO["status"] | undefined,
): boolean {
  return (
    openRunId !== null &&
    (selectedStatus === undefined || isLiveRunStatus(selectedStatus))
  );
}

export function formatRunTimestamp(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

// Deliberately independent of `exchanges`: runs parked before exchange history
// existed have none and must remain answerable.
export function shouldShowAnswerForm(parkedRun: RunDTO | undefined): boolean {
  return parkedRun !== undefined;
}

export function answeredExchanges(
  exchanges: InputExchange[],
): InputExchange[] {
  return exchanges.filter((exchange) => exchange.answer !== null);
}

export function openExchange(
  exchanges: InputExchange[],
): InputExchange | null {
  const open = exchanges.filter((exchange) => exchange.answer === null);
  return open.length > 0 ? open[open.length - 1] : null;
}
