import { createServerFn } from "@tanstack/react-start";
import type { WithId } from "mongodb";
import { z } from "zod";
import { BoardSchema, type Board } from "../domain/schemas";
import { db } from "./db";
import { boundary, type ServerResult } from "./result";

// Persisted board document: the validated board fields plus the server-owned
// audit timestamps. `_id` is added by Mongo and stripped into a string on the
// way out (see BoardDTO).
type BoardDoc = Board & { createdAt: string; updatedAt: string };

// Browser-safe board shape: identical to the stored document but with `_id`
// as a plain string instead of a BSON ObjectId. This is what crosses the
// network to the client — never a raw ObjectId.
export type BoardDTO = BoardDoc & { _id: string };

const now = () => new Date().toISOString();

function boards() {
  return db().then((d) => d.collection<BoardDoc>("boards"));
}

function toDTO(doc: WithId<BoardDoc>): BoardDTO {
  const { _id, ...rest } = doc;
  return { _id: _id.toString(), ...rest };
}

// --- Core logic (pure, testable against a real Mongo) -------------------
// The createServerFn wrappers below are thin transport: they validate input
// with Zod and delegate here. Tests exercise these directly.

export async function listBoardsCore(): Promise<BoardDTO[]> {
  const docs = await (await boards()).find().sort({ name: 1 }).toArray();
  return docs.map(toDTO);
}

export async function createBoardCore(input: Board): Promise<{ id: string }> {
  const at = now();
  const r = await (await boards()).insertOne({
    ...input,
    createdAt: at,
    updatedAt: at,
  });
  return { id: r.insertedId.toString() };
}

export async function getBoardCore(slug: string): Promise<BoardDTO> {
  const doc = await (await boards()).findOne({ slug });
  if (!doc) throw new Error(`board not found: ${slug}`);
  return toDTO(doc);
}

// --- Server functions (client transport) --------------------------------
// Each handler takes raw `unknown` and runs it through `boundary`, which
// safeParses against the explicit typed schema and returns a ServerResult —
// validation failures come back as { ok: false } instead of throwing out of
// the transport. The core functions keep throwing and stay integration-tested.

const passthrough = (data: unknown): unknown => data;

export const listBoards = createServerFn({ method: "GET" }).handler(
  (): Promise<ServerResult<BoardDTO[]>> =>
    boundary(z.unknown(), undefined, () => listBoardsCore()),
);

export const createBoard = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ id: string }>> =>
    boundary(BoardSchema, data, createBoardCore),
  );

export const getBoard = createServerFn({ method: "GET" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<BoardDTO>> =>
    boundary(z.object({ slug: z.string().min(1) }).strict(), data, (input) =>
      getBoardCore(input.slug),
    ),
  );
