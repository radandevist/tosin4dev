import { createMutation, createQuery } from "react-query-kit";
import type { Board } from "../domain/schemas";
import {
  createBoard,
  getBoard,
  listBoards,
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
