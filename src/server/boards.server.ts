import type { WithId } from "mongodb";
import type { Board } from "../domain/schemas";
import { db } from "./db";
import type { BoardDTO } from "./boards";
import { ServerResultError } from "./result";

// Persisted board document: the validated board fields plus the server-owned
// audit timestamps. `_id` is added by Mongo and stripped into a string on the
// way out (see BoardDTO).
type BoardDoc = Board & { createdAt: string; updatedAt: string };

const now = () => new Date().toISOString();

function boards() {
  return db().then((d) => d.collection<BoardDoc>("boards"));
}

function toDTO(doc: WithId<BoardDoc>): BoardDTO {
  const { _id, ...rest } = doc;
  return { _id: _id.toString(), ...rest };
}

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
  if (!doc) throw new ServerResultError("not_found", `board not found: ${slug}`);
  return toDTO(doc);
}

// Replace a board's acceptance checks wholesale, refreshing the audit timestamp
// in the same atomic write. findOneAndUpdate with returnDocument: "after"
// guarantees the returned DTO matches the stored document even if a concurrent
// write lands between our update and a follow-up read. Key uniqueness is
// enforced by the boundary schema (UpdateBoardChecksSchema), not here — the
// core trusts its validated input.
export async function updateBoardChecksCore(input: {
  slug: string;
  checks: Board["checks"];
}): Promise<BoardDTO> {
  const doc = await (
    await boards()
  ).findOneAndUpdate(
    { slug: input.slug },
    { $set: { checks: input.checks, updatedAt: now() } },
    { returnDocument: "after" },
  );
  if (!doc) {
    throw new ServerResultError("not_found", `board not found: ${input.slug}`);
  }
  return toDTO(doc);
}
