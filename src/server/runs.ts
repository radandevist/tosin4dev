import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  AbsolutePathString,
  ObjectIdString,
  RunnerName,
  RunPhase,
  RunStatus,
} from "../domain/schemas";
import {
  dispatchRunCore,
  listRunsCore,
  logTailCore,
} from "./runs.server";
import { boundary, type ServerResult } from "./result";

const timestamp = z.string().datetime();

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
    pid: z.number().int().positive().nullable(),
    exitCode: z.number().int().nullable(),
    summary: z.string().nullable(),
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
