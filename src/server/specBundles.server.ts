import type { WithId } from "mongodb";
import {
  SpecBundleSchema,
  type BundleMember,
  type SpecBundle,
  type SpecBundleProposal,
} from "../domain/schemas";
import { validateBundleMembers } from "./chatResult";
import { db, ObjectId } from "./db";
import { ServerResultError } from "./result";
import {
  SpecBundleDTOSchema,
  type BundleRef,
  type SpecBundleDTO,
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

// Upsert THE drafting bundle for a session (one per session): replace any
// existing drafting bundle's contents, or insert a new one. Returns the bundle id.
export async function replaceDraftingBundle(
  sessionId: string,
  boardId: string,
  proposal: SpecBundleProposal,
): Promise<string> {
  const coll = await specBundles();
  const at = now();
  const existing = await coll.findOne({ sessionId, status: "drafting" });
  if (existing) {
    await coll.updateOne(
      { _id: existing._id },
      {
        $set: {
          rationale: proposal.rationale,
          members: proposal.members,
          updatedAt: at,
        },
      },
    );
    return existing._id.toString();
  }
  const r = await coll.insertOne({
    sessionId,
    boardId,
    status: "drafting",
    rationale: proposal.rationale,
    members: proposal.members,
    lockedTicketIds: null,
    createdAt: at,
    updatedAt: at,
    lockedAt: null,
  });
  return r.insertedId.toString();
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

async function requireDrafting(bundleId: string): Promise<WithId<SpecBundleDoc>> {
  const doc = await loadBundle(bundleId); // loadBundle: id-only lookup, no status guard
  if (doc.status !== "drafting") {
    throw new ServerResultError("conflict", "this bundle is locked");
  }
  return doc;
}

// Persist edited members after re-validating structure; fail closed on invalid.
async function saveMembers(bundleId: string, members: BundleMember[]): Promise<void> {
  const invalid = validateBundleMembers(members);
  if (invalid) throw new ServerResultError("conflict", invalid);
  const coll = await specBundles();
  await coll.updateOne(
    { _id: new ObjectId(bundleId), status: "drafting" },
    { $set: { members, updatedAt: now() } },
  );
}

export async function updateBundleMemberCore(input: {
  bundleId: string;
  localKey: string;
  patch: Partial<
    Pick<BundleMember, "title" | "type" | "runner" | "spec" | "dependsOn">
  >;
}): Promise<{ ok: true }> {
  const doc = await requireDrafting(input.bundleId);
  const members = doc.members.map((m) =>
    m.localKey === input.localKey ? { ...m, ...input.patch } : m,
  );
  if (!doc.members.some((m) => m.localKey === input.localKey)) {
    throw new ServerResultError("not_found", `no member: ${input.localKey}`);
  }
  await saveMembers(input.bundleId, members);
  return { ok: true };
}

export async function dropBundleMemberCore(input: {
  bundleId: string;
  localKey: string;
}): Promise<{ ok: true }> {
  const doc = await requireDrafting(input.bundleId);
  const members = doc.members
    .filter((m) => m.localKey !== input.localKey)
    .map((m) => ({
      ...m,
      dependsOn: m.dependsOn.filter((d) => d !== input.localKey),
    }));
  await saveMembers(input.bundleId, members); // validator rejects dropping to 0
  return { ok: true };
}

export async function reorderBundleCore(input: {
  bundleId: string;
  orderedLocalKeys: string[];
}): Promise<{ ok: true }> {
  const doc = await requireDrafting(input.bundleId);
  const current = new Set(doc.members.map((m) => m.localKey));
  const next = new Set(input.orderedLocalKeys);
  if (current.size !== next.size || [...current].some((k) => !next.has(k))) {
    throw new ServerResultError(
      "conflict",
      "reorder must be a permutation of current keys",
    );
  }
  const byKey = new Map(doc.members.map((m) => [m.localKey, m]));
  const members = input.orderedLocalKeys.map((k) => byKey.get(k)!);
  await saveMembers(input.bundleId, members);
  return { ok: true };
}

// Lock core is implemented in Task 6.
export async function lockBundleCore(_input: BundleRef): Promise<never> {
  throw new ServerResultError("conflict", "not implemented");
}
