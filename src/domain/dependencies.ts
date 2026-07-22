import type { z } from "zod";
import type { TicketStatus } from "./schemas";

export type DepStatus = z.infer<typeof TicketStatus>;
export type UnmetReason = "pending" | "archived" | "missing";

export interface UnmetDependency {
  ticketId: string;
  seq: number | null;
  status: DepStatus | null;
  reason: UnmetReason;
}

export function unmetDependencies(
  deps: string[],
  present: { ticketId: string; seq: number; status: DepStatus }[],
): UnmetDependency[] {
  const presentById = new Map(present.map((dep) => [dep.ticketId, dep]));

  return deps.flatMap<UnmetDependency>((ticketId) => {
    const dep = presentById.get(ticketId);
    if (!dep) {
      return [{ ticketId, seq: null, status: null, reason: "missing" }];
    }
    if (dep.status === "done") return [];

    return [
      {
        ticketId,
        seq: dep.seq,
        status: dep.status,
        reason: dep.status === "archived" ? "archived" : "pending",
      },
    ];
  });
}
