import { createServerFn } from "@tanstack/react-start";
import { MongoServerError, type PushOperator, type WithId } from "mongodb";
import { z } from "zod";
import {
  CreateTicketInputSchema,
  ObjectIdString,
  SetRunnerInputSchema,
  TicketSchema,
  TicketStatus,
  UpdateSpecInputSchema,
  type CreateTicketInput,
  type SetRunnerInput,
  type Ticket,
  type UpdateSpecInput,
} from "../domain/schemas";
import { PublicEventSchema, transition } from "../domain/stateMachine";
import { db, ObjectId } from "./db";
import { boundary, ServerResultError, type ServerResult } from "./result";

// Persisted ticket document: the validated ticket fields plus server-owned
// audit timestamps. `_id` is added by Mongo and stripped to a string on the
// way out (see TicketDTO).
type TicketDoc = Ticket & { createdAt: string; updatedAt: string };

// Browser-safe ticket shape: the stored document with `_id` as a plain string
// instead of a BSON ObjectId. boardId/activeRunId are already stored as strings
// (ObjectIdString), so nothing else needs unwrapping — no raw ObjectId/BSON
// ever crosses the wire.
export type TicketDTO = TicketDoc & { _id: string };

// The public transition input. `event` is validated against PublicEventSchema
// (human UI events only — no dispatch/run_succeeded/run_failed), and `.strict()`
// keeps the server-owned prUrl out: the PR link is set by the supervisor, never
// by the browser.
export const TransitionInputSchema = z
  .object({
    ticketId: ObjectIdString,
    event: PublicEventSchema,
  })
  .strict();
export type TransitionInput = z.infer<typeof TransitionInputSchema>;

// Keep the seq-collision retry bounded and tiny: last-seq+1 is racy under a
// unique {boardId, seq} index, but a single retry recomputes the next seq off
// the winner and settles it. No counter/sequence abstraction for v1.
const MAX_INSERT_ATTEMPTS = 2;
const ACTIVITY_CAP = 50;

const now = () => new Date().toISOString();

function tickets() {
  return db().then((d) => d.collection<TicketDoc>("tickets"));
}

function toDTO(doc: WithId<TicketDoc>): TicketDTO {
  // Hydrate the persisted ticket fields through TicketSchema so legacy
  // documents written before a field existed (e.g. spec.approvedBy) pick up its
  // schema default (null) instead of surfacing `undefined` to the client. The
  // server-owned audit timestamps and `_id` live outside TicketSchema, so we
  // carry them across untouched rather than dropping them.
  const { _id, createdAt, updatedAt, ...ticketFields } = doc;
  const ticket = TicketSchema.parse(ticketFields);
  return { _id: _id.toString(), ...ticket, createdAt, updatedAt };
}

function isDuplicateKeyError(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

// A $push that appends one activity entry and trims to the last ACTIVITY_CAP,
// in the same atomic update as the state change. Kept as a helper so update and
// transition apply the cap identically.
function pushActivity(
  kind: string,
  message: string,
  at: string,
): PushOperator<TicketDoc> {
  return {
    activity: {
      $each: [{ at, kind, message }],
      $slice: -ACTIVITY_CAP,
    },
  };
}

// --- Core logic (pure, testable against a real Mongo) -------------------

export async function listTicketsCore(boardId: string): Promise<TicketDTO[]> {
  const docs = await (await tickets())
    .find({ boardId })
    .sort({ seq: -1 })
    .toArray();
  return docs.map(toDTO);
}

export async function getTicketCore(
  boardId: string,
  seq: number,
): Promise<TicketDTO> {
  const doc = await (await tickets()).findOne({ boardId, seq });
  if (!doc) {
    throw new ServerResultError(
      "not_found",
      `ticket not found: board ${boardId} seq ${seq}`,
    );
  }
  return toDTO(doc);
}

export async function createTicketCore(
  input: CreateTicketInput,
): Promise<{ id: string; seq: number }> {
  const coll = await tickets();

  for (let attempt = 1; ; attempt++) {
    // last-seq+1, per board. The unique {boardId, seq} index is the real guard;
    // this read just proposes the next number.
    const last = await coll
      .find({ boardId: input.boardId })
      .sort({ seq: -1 })
      .limit(1)
      .next();
    const seq = (last?.seq ?? 0) + 1;
    const at = now();

    // Server owns every non-input field: seq/status/activeRunId/prUrl/activity
    // and the timestamps. approvedAt starts null — approval is a server action.
    const doc: TicketDoc = {
      boardId: input.boardId,
      seq,
      title: input.title,
      type: input.type,
      status: "inbox",
      runner: input.runner,
      spec: { ...input.spec, approvedAt: null, approvedBy: null },
      activeRunId: null,
      prUrl: null,
      activity: [{ at, kind: "lifecycle", message: "ticket created" }],
      createdAt: at,
      updatedAt: at,
    };

    try {
      const r = await coll.insertOne(doc);
      return { id: r.insertedId.toString(), seq };
    } catch (err) {
      // A concurrent create grabbed this seq first: recompute and retry once.
      if (isDuplicateKeyError(err) && attempt < MAX_INSERT_ATTEMPTS) continue;
      throw err;
    }
  }
}

export async function updateSpecCore(input: UpdateSpecInput): Promise<void> {
  const coll = await tickets();
  const at = now();

  // Editing the spec clears any prior approval: an approved spec that changes
  // must be re-approved, so both approval fields are reset to null here (and the
  // input schema never lets a client send approvedAt/approvedBy in the first
  // place).
  const res = await coll.updateOne(
    { _id: new ObjectId(input.ticketId) },
    {
      $set: {
        spec: { ...input.spec, approvedAt: null, approvedBy: null },
        updatedAt: at,
      },
      $push: pushActivity("spec", "spec updated", at),
    },
  );

  if (res.matchedCount === 0) {
    throw new ServerResultError(
      "not_found",
      `ticket not found: ${input.ticketId}`,
    );
  }
}

export async function setRunnerCore(input: SetRunnerInput): Promise<void> {
  const coll = await tickets();
  const at = now();

  const res = await coll.updateOne(
    { _id: new ObjectId(input.ticketId) },
    {
      $set: { runner: input.runner, updatedAt: at },
      $push: pushActivity("runner", `runner set to ${input.runner}`, at),
    },
  );

  if (res.matchedCount === 0) {
    throw new ServerResultError(
      "not_found",
      `ticket not found: ${input.ticketId}`,
    );
  }
}

export async function transitionTicketCore(
  input: TransitionInput,
): Promise<{ status: string }> {
  const coll = await tickets();

  const doc = await coll.findOne({ _id: new ObjectId(input.ticketId) });
  if (!doc) {
    throw new ServerResultError(
      "not_found",
      `ticket not found: ${input.ticketId}`,
    );
  }

  // Re-validate the persisted status through the domain enum before trusting it
  // as a machine input — a corrupt/legacy value fails loudly here rather than
  // silently producing a bogus edge.
  const from = TicketStatus.parse(doc.status);
  const to = transition(from, input.event);
  const at = now();

  const set: Partial<TicketDoc> = { status: to, updatedAt: at };
  // Approval metadata is server-owned: stamped only on approve_spec, from the
  // already-loaded spec so we never touch other spec fields. approvedBy is
  // pinned to the sole operator, "radan".
  if (input.event === "approve_spec") {
    set.spec = { ...doc.spec, approvedAt: at, approvedBy: "radan" };
  }

  // Optimistic concurrency: the update only lands if the ticket is still in the
  // status we read. If a concurrent transition already moved it, matchedCount is
  // 0 and we surface a conflict instead of overwriting the winner.
  const res = await coll.updateOne(
    { _id: doc._id, status: from },
    {
      $set: set,
      $push: pushActivity("transition", `${from} --${input.event}--> ${to}`, at),
    },
  );

  if (res.matchedCount === 0) {
    throw new ServerResultError(
      "conflict",
      `stale ticket transition: ${input.ticketId} is no longer in ${from}`,
    );
  }

  return { status: to };
}

// --- Server functions (client transport) --------------------------------
// Every handler takes raw `unknown` and runs it through `boundary`, which
// safeParses against the explicit typed schema and returns a ServerResult —
// so a validation failure surfaces as { ok: false } rather than throwing out
// of the transport before the handler runs. The core functions keep throwing
// and stay directly integration-tested above.

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
