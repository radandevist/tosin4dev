import { createMutation, createQuery } from "react-query-kit";
import {
  dropBundleMember,
  getBundle,
  lockBundle,
  reorderBundle,
  updateBundleMember,
  type BundleRef,
  type DropBundleMemberInput,
  type ReorderBundleInput,
  type SpecBundleDTO,
  type UpdateBundleMemberInput,
} from "../server/specBundles";
import { unwrapResult } from "../server/result";

export const useBundle = createQuery<SpecBundleDTO, BundleRef>({
  queryKey: ["bundle"],
  fetcher: (variables) => getBundle({ data: variables }).then(unwrapResult),
});

export const useUpdateBundleMember = createMutation<
  { ok: true },
  UpdateBundleMemberInput
>({
  mutationFn: (variables) =>
    updateBundleMember({ data: variables }).then(unwrapResult),
});

export const useDropBundleMember = createMutation<
  { ok: true },
  DropBundleMemberInput
>({
  mutationFn: (variables) =>
    dropBundleMember({ data: variables }).then(unwrapResult),
});

export const useReorderBundle = createMutation<
  { ok: true },
  ReorderBundleInput
>({
  mutationFn: (variables) =>
    reorderBundle({ data: variables }).then(unwrapResult),
});

export const useLockBundle = createMutation<
  { tickets: { ticketId: string; seq: number }[] },
  BundleRef
>({
  mutationFn: (variables) =>
    lockBundle({ data: variables }).then(unwrapResult),
});
