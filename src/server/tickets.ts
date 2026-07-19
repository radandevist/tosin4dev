import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  CreateTicketInputSchema,
  ObjectIdString,
  SetRunnerInputSchema,
  UpdateSpecInputSchema,
  type Ticket,
} from "../domain/schemas";
import { PublicEventSchema } from "../domain/stateMachine";
import { boundary, type ServerResult } from "./result";
import {
  createTicketCore,
  getTicketCore,
  listTicketsCore,
  setRunnerCore,
  transitionTicketCore,
  updateSpecCore,
} from "./tickets.server";

type TicketDoc = Ticket & { createdAt: string; updatedAt: string };

// Browser-safe wire contract. All referenced ids and `_id` are plain strings.
export type TicketDTO = TicketDoc & { _id: string };

// Human UI events only; machine dispatch outcomes remain server-owned.
export const TransitionInputSchema = z
  .object({
    ticketId: ObjectIdString,
    event: PublicEventSchema,
  })
  .strict();
export type TransitionInput = z.infer<typeof TransitionInputSchema>;

const passthrough = (data: unknown): unknown => data;

export const listTickets = createServerFn({ method: "GET" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<TicketDTO[]>> =>
    boundary(z.object({ boardId: ObjectIdString }).strict(), data, (input) =>
      listTicketsCore(input.boardId),
    ),
  );

export const getTicket = createServerFn({ method: "GET" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<TicketDTO>> =>
    boundary(
      z
        .object({ boardId: ObjectIdString, seq: z.number().int().positive() })
        .strict(),
      data,
      (input) => getTicketCore(input.boardId, input.seq),
    ),
  );

export const createTicket = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ id: string; seq: number }>> =>
    boundary(CreateTicketInputSchema, data, createTicketCore),
  );

export const updateSpec = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<void>> =>
    boundary(UpdateSpecInputSchema, data, updateSpecCore),
  );

export const setRunner = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<void>> =>
    boundary(SetRunnerInputSchema, data, setRunnerCore),
  );

export const transitionTicket = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ status: string }>> =>
    boundary(TransitionInputSchema, data, transitionTicketCore),
  );
