import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  AbsolutePathString,
  InputExchangeSchema,
  ObjectIdString,
  RunnerName,
  RunPhase,
  RunStatus,
} from "../domain/schemas";
import {
  dispatchRunCore,
  listRunsCore,
  logTailCore,
  turnTailCore,
} from "./runs.server";
import { boundary, type ServerResult } from "./result";

const timestamp = z.string().datetime();

export const RunTurnDTOSchema = z
  .object({
    v: z.literal(1),
    id: z.string().min(1),
    index: z.number().int().nonnegative(),
    at: timestamp,
    kind: z.enum(["dispatch", "resume"]),
    stdoutFile: AbsolutePathString,
    stderrFile: AbsolutePathString,
  })
  .strict();
export type RunTurnDTO = z.infer<typeof RunTurnDTOSchema>;

export const RunDTOSchema = z
  .object({
    _id: ObjectIdString,
    ticketId: ObjectIdString,
    boardId: ObjectIdString,
    runner: RunnerName,
    phase: RunPhase,
    status: RunStatus,
    workDir: AbsolutePathString,
    promptFile: AbsolutePathString,
    logFile: AbsolutePathString,
    stderrFile: AbsolutePathString.nullable(),
    pid: z.number().int().positive().nullable(),
    exitCode: z.number().int().nullable(),
    summary: z.string().nullable(),
    awaitingQuestion: z.string().nullable(),
    exchanges: z.array(InputExchangeSchema),
    exchangesDropped: z.number().int().nonnegative(),
    turns: z.array(RunTurnDTOSchema).default([]),
    queuedAt: timestamp,
    startedAt: timestamp.nullable(),
    finishedAt: timestamp.nullable(),
  })
  .strict();
export type RunDTO = z.infer<typeof RunDTOSchema>;

export const ListRunsInputSchema = z
  .object({ ticketId: ObjectIdString })
  .strict();
export type ListRunsInput = z.infer<typeof ListRunsInputSchema>;

export const DispatchRunInputSchema = z
  .object({ ticketId: ObjectIdString, phase: RunPhase })
  .strict();
export type DispatchRunInput = z.infer<typeof DispatchRunInputSchema>;

export const LogTailInputSchema = z
  .object({
    runId: ObjectIdString,
    bytes: z.number().int().positive().max(100_000).default(20_000),
  })
  .strict();
export type LogTailInput = z.infer<typeof LogTailInputSchema>;
export type LogTailVariables = z.input<typeof LogTailInputSchema>;

export const TurnTailInputSchema = z
  .object({
    runId: ObjectIdString,
    turnId: z.string().min(1),
    cursor: z.number().int().nonnegative().default(0),
    maxBytes: z.number().int().positive().max(100_000).default(20_000),
    stream: z.enum(["stdout", "stderr"]).default("stdout"),
  })
  .strict();
export type TurnTailInput = z.infer<typeof TurnTailInputSchema>;
export type TurnTailVariables = z.input<typeof TurnTailInputSchema>;
export type TurnTailResult = { chunk: string; nextCursor: number; eof: boolean };

const passthrough = (data: unknown): unknown => data;

export const listRuns = createServerFn({ method: "GET" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<RunDTO[]>> =>
    boundary(ListRunsInputSchema, data, listRunsCore),
  );

export const dispatch = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ runId: string }>> =>
    boundary(DispatchRunInputSchema, data, dispatchRunCore),
  );

export const logTail = createServerFn({ method: "GET" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ text: string }>> =>
    boundary(LogTailInputSchema, data, logTailCore),
  );

export const turnTail = createServerFn({ method: "GET" })
  .validator(passthrough)
  .handler(
    ({ data }): Promise<ServerResult<TurnTailResult>> =>
      boundary(TurnTailInputSchema, data, turnTailCore),
  );
