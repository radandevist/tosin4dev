import { createMutation, createQuery } from "react-query-kit";
import type {
  CreateTicketInput,
  SetRunnerInput,
  UpdateSpecInput,
} from "../domain/schemas";
import {
  createTicket,
  getTicket,
  listTickets,
  provideInput,
  setRunner,
  transitionTicket,
  updateSpec,
  type TicketDTO,
  type ProvideInputInput,
  type TransitionInput,
} from "../server/tickets";
import { unwrapResult } from "../server/result";

// Keys are stable and variable-scoped: react-query-kit appends the hook's
// variables to the root segment, so ["tickets", { boardId }] and
// ["ticket", { boardId, seq }] are distinct cache entries. Task 5 invalidates
// through `useTickets.getKey({ boardId })` etc.

export const useTickets = createQuery<TicketDTO[], { boardId: string }>({
  queryKey: ["tickets"],
  fetcher: (variables) => listTickets({ data: variables }).then(unwrapResult),
});

export const useTicket = createQuery<
  TicketDTO,
  { boardId: string; seq: number }
>({
  queryKey: ["ticket"],
  fetcher: (variables) => getTicket({ data: variables }).then(unwrapResult),
});

export const useCreateTicket = createMutation<
  { id: string; seq: number },
  CreateTicketInput
>({
  mutationFn: (variables) => createTicket({ data: variables }).then(unwrapResult),
});

export const useUpdateSpec = createMutation<void, UpdateSpecInput>({
  mutationFn: (variables) => updateSpec({ data: variables }).then(unwrapResult),
});

export const useSetRunner = createMutation<void, SetRunnerInput>({
  mutationFn: (variables) => setRunner({ data: variables }).then(unwrapResult),
});

export const useTransition = createMutation<{ status: string }, TransitionInput>(
  {
    mutationFn: (variables) =>
      transitionTicket({ data: variables }).then(unwrapResult),
  },
);

export const useProvideInput = createMutation<
  { status: string },
  ProvideInputInput
>({
  mutationFn: (variables) =>
    provideInput({ data: variables }).then(unwrapResult),
});
