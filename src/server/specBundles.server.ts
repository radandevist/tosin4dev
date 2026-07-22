import type { WithId } from "mongodb";
import { SpecBundleSchema, type SpecBundle } from "../domain/schemas";
import { db, ObjectId } from "./db";
import { ServerResultError } from "./result";
import {
  SpecBundleDTOSchema,
  type BundleRef,
  type DropBundleMemberInput,
  type ReorderBundleInput,
  type SpecBundleDTO,
  type UpdateBundleMemberInput,
} from "./specBundles";

export type SpecBundleDoc = SpecBundle & {
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
};

export const now = () => new Date().toISOString();

export function specBundles() {
  return db().then((d) => d.collection<SpecBundleDoc>("specBundles"));
}

// Explicit field-pick (never spread) — the server-only lockedAt never leaks.
export function bundleToDTO(doc: WithId<SpecBundleDoc>): SpecBundleDTO {
  const validated = SpecBundleSchema.parse({
    sessionId: doc.sessionId,
    boardId: doc.boardId,
    status: doc.status,
    rationale: doc.rationale,
    members: doc.members,
    lockedTicketIds: doc.lockedTicketIds,
  });
  return SpecBundleDTOSchema.parse({
    _id: doc._id.toString(),
    sessionId: validated.sessionId,
    boardId: validated.boardId,
    status: validated.status,
    rationale: validated.rationale,
    members: validated.members,
    lockedTicketIds: validated.lockedTicketIds,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}

// Load a bundle by id regardless of status (readers may view a locked bundle).
// Mutation cores in Tasks 5-6 must add their OWN drafting-status guard on top.
async function loadBundle(bundleId: string): Promise<WithId<SpecBundleDoc>> {
  const coll = await specBundles();
  const doc = await coll.findOne({ _id: new ObjectId(bundleId) });
  if (!doc) throw new ServerResultError("not_found", `bundle not found: ${bundleId}`);
  return doc;
}

export async function getBundleCore(input: { bundleId: string }): Promise<SpecBundleDTO> {
  return bundleToDTO(await loadBundle(input.bundleId));
}

// Edit + lock cores are implemented in Tasks 5 & 6.
export async function updateBundleMemberCore(
  _input: UpdateBundleMemberInput,
): Promise<never> {
  throw new ServerResultError("conflict", "not implemented");
}

export async function dropBundleMemberCore(
  _input: DropBundleMemberInput,
): Promise<never> {
  throw new ServerResultError("conflict", "not implemented");
}

export async function reorderBundleCore(
  _input: ReorderBundleInput,
): Promise<never> {
  throw new ServerResultError("conflict", "not implemented");
}

export async function lockBundleCore(_input: BundleRef): Promise<never> {
  throw new ServerResultError("conflict", "not implemented");
}
