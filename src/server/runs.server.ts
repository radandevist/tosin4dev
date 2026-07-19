import { open } from "node:fs/promises";
import type { WithId } from "mongodb";
import type { Run } from "../domain/schemas";
import { db, ObjectId } from "./db";
import type {
  DispatchRunInput,
  ListRunsInput,
  LogTailInput,
  RunDTO,
} from "./runs";
import { RunDTOSchema } from "./runs";
import { ServerResultError } from "./result";
import { dispatchRun } from "./supervisor.server";

type RunDoc = Run & {
  pid: number | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

function toDTO(doc: WithId<RunDoc>): RunDTO {
  const { _id, ...run } = doc;
  return RunDTOSchema.parse({ _id: _id.toString(), ...run });
}

export async function listRunsCore(
  input: ListRunsInput,
): Promise<RunDTO[]> {
  const docs = await (await db())
    .collection<RunDoc>("runs")
    .find({ ticketId: input.ticketId })
    .sort({ queuedAt: -1 })
    .toArray();
  return docs.map(toDTO);
}

export function dispatchRunCore(
  input: DispatchRunInput,
): Promise<{ runId: string }> {
  return dispatchRun(input.ticketId, input.phase);
}

export async function readLogTail(
  logFile: string,
  bytes: number,
): Promise<string> {
  let handle;
  try {
    handle = await open(logFile, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function logTailCore(
  input: LogTailInput,
): Promise<{ text: string }> {
  const run = await (await db())
    .collection<RunDoc>("runs")
    .findOne({ _id: new ObjectId(input.runId) });
  if (!run) {
    throw new ServerResultError("not_found", `run not found: ${input.runId}`);
  }
  return { text: await readLogTail(run.logFile, input.bytes) };
}
