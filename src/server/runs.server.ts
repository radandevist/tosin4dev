import { open } from "node:fs/promises";
import type { WithId } from "mongodb";
import { InputExchangeSchema, type Run } from "../domain/schemas";
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
  const {
    _id,
    ticketId,
    boardId,
    runner,
    phase,
    status,
    workDir,
    promptFile,
    logFile,
    stderrFile,
    pid,
    exitCode,
    summary,
    awaitingQuestion,
    queuedAt,
    startedAt,
    finishedAt,
  } = doc;
  return RunDTOSchema.parse({
    _id: _id.toString(),
    ticketId,
    boardId,
    runner,
    phase,
    status,
    workDir,
    promptFile,
    logFile,
    stderrFile: stderrFile ?? null,
    pid,
    exitCode,
    summary,
    awaitingQuestion,
    exchanges: (doc.exchanges ?? []).flatMap((exchange) => {
      const parsed = InputExchangeSchema.safeParse(exchange);
      return parsed.success ? [parsed.data] : [];
    }),
    queuedAt,
    startedAt,
    finishedAt,
  });
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
    // Skip leading UTF-8 continuation bytes (0b10xxxxxx) so the window starts
    // on a character boundary. Otherwise toString() substitutes U+FFFD — 3
    // bytes — for the 1-2 partial bytes, and the decoded string can exceed the
    // caller's byte budget.
    let start = 0;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
    return buffer.subarray(start).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export const STDERR_DELIMITER = "──── stderr ────";

export async function logTailCore(
  input: LogTailInput,
): Promise<{ text: string }> {
  const run = await (await db())
    .collection<RunDoc>("runs")
    .findOne({ _id: new ObjectId(input.runId) });
  if (!run) {
    throw new ServerResultError("not_found", `run not found: ${input.runId}`);
  }
  if (!run.stderrFile) {
    return { text: await readLogTail(run.logFile, input.bytes) };
  }
  // Read stderr FIRST. Most runs write nothing there, and the stdout budget
  // must not be halved to reserve room for a section that turns out empty.
  const joiner = `\n${STDERR_DELIMITER}\n`;
  const joinerBytes = Buffer.byteLength(joiner, "utf8");
  // Clamp so the joiner itself can never push the result past the ceiling:
  // spent = stderrBytes + joinerBytes <= (bytes - joinerBytes) + joinerBytes.
  const stderrBudget = Math.max(
    0,
    Math.min(Math.floor(input.bytes / 2), input.bytes - joinerBytes),
  );
  const stderr = await readLogTail(run.stderrFile, stderrBudget);
  if (!stderr) {
    return { text: await readLogTail(run.logFile, input.bytes) };
  }
  // Charge the joiner and the stderr section against the caller's ceiling so
  // stdout + joiner + stderr <= bytes. Measure in BYTES, not chars: readLogTail
  // budgets a Buffer, and box-drawing/UTF-8 chars are multi-byte.
  const spent = Buffer.byteLength(stderr, "utf8") + joinerBytes;
  const stdout = await readLogTail(
    run.logFile,
    Math.max(0, input.bytes - spent),
  );
  return { text: `${stdout}${joiner}${stderr}` };
}
