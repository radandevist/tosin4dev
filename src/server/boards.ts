import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { BoardSchema, type Board } from "../domain/schemas";
import {
  createBoardCore,
  getBoardCore,
  listBoardsCore,
} from "./boards.server";
import { boundary, type ServerResult } from "./result";

type BoardDoc = Board & { createdAt: string; updatedAt: string };

// Browser-safe wire contract. No BSON value crosses the RPC boundary.
export type BoardDTO = BoardDoc & { _id: string };

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
