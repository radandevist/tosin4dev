import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { BundleMemberSchema, ObjectIdString, SpecInputSchema, TicketType, RunnerName } from "../domain/schemas";
import { boundary, type ServerResult } from "./result";
import {
  dropBundleMemberCore,
  getBundleCore,
  lockBundleCore,
  reorderBundleCore,
  updateBundleMemberCore,
} from "./specBundles.server";

const timestamp = z.string().datetime();

// Client-facing bundle. Omits server-owned lockedAt/createdAt-internal bookkeeping.
export const SpecBundleDTOSchema = z
  .object({
    _id: ObjectIdString,
    sessionId: ObjectIdString,
    boardId: ObjectIdString,
    status: z.enum(["drafting", "locked"]),
    rationale: z.string(),
    members: z.array(BundleMemberSchema),
    lockedTicketIds: z.array(ObjectIdString).nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type SpecBundleDTO = z.infer<typeof SpecBundleDTOSchema>;

export const BundleRefSchema = z.object({ bundleId: ObjectIdString }).strict();
export type BundleRef = z.infer<typeof BundleRefSchema>;

// A member edit: the fields a human may change on a drafting member.
export const UpdateBundleMemberInputSchema = z
  .object({
    bundleId: ObjectIdString,
    localKey: z.string().min(1),
    patch: z
      .object({
        title: z.string().min(1).optional(),
        type: TicketType.optional(),
        runner: RunnerName.optional(),
        spec: SpecInputSchema.optional(),
        dependsOn: z.array(z.string()).optional(),
      })
      .strict(),
  })
  .strict();
export type UpdateBundleMemberInput = z.infer<typeof UpdateBundleMemberInputSchema>;

export const DropBundleMemberInputSchema = z
  .object({ bundleId: ObjectIdString, localKey: z.string().min(1) })
  .strict();
export type DropBundleMemberInput = z.infer<typeof DropBundleMemberInputSchema>;

export const ReorderBundleInputSchema = z
  .object({ bundleId: ObjectIdString, orderedLocalKeys: z.array(z.string().min(1)).min(1) })
  .strict();
export type ReorderBundleInput = z.infer<typeof ReorderBundleInputSchema>;

const passthrough = (data: unknown): unknown => data;

export const getBundle = createServerFn({ method: "GET" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<SpecBundleDTO>> =>
    boundary(BundleRefSchema, data, getBundleCore),
  );

export const updateBundleMember = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ ok: true }>> =>
    boundary(UpdateBundleMemberInputSchema, data, updateBundleMemberCore),
  );

export const dropBundleMember = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ ok: true }>> =>
    boundary(DropBundleMemberInputSchema, data, dropBundleMemberCore),
  );

export const reorderBundle = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ ok: true }>> =>
    boundary(ReorderBundleInputSchema, data, reorderBundleCore),
  );

export const lockBundle = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ tickets: { ticketId: string; seq: number }[] }>> =>
    boundary(BundleRefSchema, data, lockBundleCore),
  );
