import { createMutation, createQuery } from "react-query-kit";
import type {
  Board,
  UpdateBoardChecksInput,
} from "../domain/schemas";
import {
  createBoard,
  getBoard,
  listBoards,
  updateBoardChecks,
  type BoardDTO,
} from "../server/boards";
import { unwrapResult } from "../server/result";

// react-query-kit builds the effective query key as [...queryKey, variables],
// so every hook's key is stable and includes its variables automatically. The
// root segments below are what Task 5 invalidates against via `.getKey(...)`.

export const useBoards = createQuery<BoardDTO[]>({
  queryKey: ["boards"],
  fetcher: () => listBoards().then(unwrapResult),
});

export const useBoard = createQuery<BoardDTO, { slug: string }>({
  queryKey: ["board"],
  fetcher: (variables) => getBoard({ data: variables }).then(unwrapResult),
});

export const useCreateBoard = createMutation<{ id: string }, Board>({
  mutationFn: (variables) => createBoard({ data: variables }).then(unwrapResult),
});

// Wired mutation for the board page's checks editor (unlike the orphaned
// useUpdateSpec/useSetRunner). Returns the updated board DTO so the caller can
// reconcile its local form; the board query is invalidated by the caller via
// useBoard.getKey({ slug }) after success.
export const useUpdateBoardChecks = createMutation<
  BoardDTO,
  UpdateBoardChecksInput
>({
  mutationFn: (variables) =>
    updateBoardChecks({ data: variables }).then(unwrapResult),
});
