import { createMutation, createQuery } from "react-query-kit";
import type { CreateTicketInput, UpdateSpecInput } from "../domain/schemas";
import {
  createTicket,
  getTicket,
  listTickets,
  transitionTicket,
  updateSpec,
  type TicketDTO,
  type TransitionInput,
} from "../server/tickets";

// Keys are stable and variable-scoped: react-query-kit appends the hook's
// variables to the root segment, so ["tickets", { boardId }] and
// ["ticket", { boardId, seq }] are distinct cache entries. Task 5 invalidates
// through `useTickets.getKey({ boardId })` etc.

export const useTickets = createQuery<TicketDTO[], { boardId: string }>({
  queryKey: ["tickets"],
  fetcher: (variables) => listTickets({ data: variables }),
});

export const useTicket = createQuery<
  TicketDTO,
  { boardId: string; seq: number }
>({
  queryKey: ["ticket"],
  fetcher: (variables) => getTicket({ data: variables }),
});

export const useCreateTicket = createMutation<
  { id: string; seq: number },
  CreateTicketInput
>({
  mutationFn: (variables) => createTicket({ data: variables }),
});

export const useUpdateSpec = createMutation<void, UpdateSpecInput>({
  mutationFn: (variables) => updateSpec({ data: variables }),
});

export const useTransition = createMutation<{ status: string }, TransitionInput>(
  {
    mutationFn: (variables) => transitionTicket({ data: variables }),
  },
);
