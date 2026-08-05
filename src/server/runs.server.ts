import { open } from "node:fs/promises";
import type { WithId } from "mongodb";
import type { Run } from "../domain/schemas";
import { db, ObjectId } from "./db";
import { projectExchanges } from "./runExchanges";
import type {
  DispatchRunInput,
  ListRunsInput,
  LogTailInput,
  RunDTO,
  RunTurnDTO,
  TurnTailInput,
} from "./runs";
import { RunDTOSchema, RunTurnDTOSchema } from "./runs";
import { ServerResultError } from "./result";
import { dispatchRun } from "./supervisor.server";

type RunDoc = Run & {
  pid: number | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

// Defensive projection for the turns array, mirroring projectExchanges: a
// malformed/legacy row is dropped — never fatal — and a missing array hydrates
// as empty so pre-slice runs still list.
function projectTurns(raw: unknown): RunTurnDTO[] {
  const rows = Array.isArray(raw) ? raw : [];
  return rows.flatMap((turn) => {
    const parsed = RunTurnDTOSchema.safeParse(turn);
    return parsed.success ? [parsed.data] : [];
  });
}

function toDTO(doc: WithId<RunDoc>): RunDTO {
  const { exchanges, dropped } = projectExchanges(doc.exchanges);
  const turns = projectTurns(doc.turns);
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
    parkedBy,
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
    parkedBy,
    exchanges,
    exchangesDropped: dropped,
    turns,
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

// Incremental per-turn tail. The client polls forward with a byte offset and
// only ever receives complete newline-terminated content (plus, once the run is
// done, any newline-less residue at EOF). nextCursor is measured in BYTES.
export async function turnTailCore(
  input: TurnTailInput,
): Promise<{ chunk: string; nextCursor: number; eof: boolean }> {
  const run = await (await db())
    .collection<RunDoc>("runs")
    .findOne({ _id: new ObjectId(input.runId) });
  if (!run) {
    throw new ServerResultError("not_found", `run not found: ${input.runId}`);
  }
  const turns = Array.isArray(run.turns) ? run.turns : [];
  const turn = turns.find((t) => t.id === input.turnId);
  if (!turn) {
    throw new ServerResultError("not_found", `turn not found: ${input.turnId}`);
  }
  const file = input.stream === "stderr" ? turn.stderrFile : turn.stdoutFile;
  // `eof` is a property of the TURN, not the run. Three ways a turn is over:
  // it declared an outcome; a LATER turn exists, which can only happen once this
  // one released the run (dispatch/resume turns never get an outcome written, so
  // this is the clause that actually covers them); or the run itself is no longer
  // producing. A `queued` run has not written a byte yet, so it is not eof.
  const turnIndex = turns.findIndex((candidate) => candidate.id === input.turnId);
  const superseded = turnIndex >= 0 && turnIndex < turns.length - 1;
  const finished =
    turn.outcome !== null ||
    superseded ||
    (run.status !== "running" && run.status !== "queued");

  let handle;
  try {
    handle = await open(file, "r");
    const { size } = await handle.stat();
    // Cursor beyond EOF: the file was truncated or rotated. Restart from the top
    // of the replacement rather than clamping to its size — clamping skips every
    // byte written before the next poll. Turn files are append-only in practice,
    // so this is a safety net; duplicate delivery beats silent loss for a log.
    // Strictly GREATER, not >=: a cursor that has caught up exactly to the file
    // size is a normal completed read, not a truncation — >= would rewind it to
    // 0 and re-deliver the whole file on every poll.
    if (input.cursor > size) {
      // Always `eof: false`: a restart means at least one more poll is required by
      // construction, and a client that stops on eof would never read the
      // replacement.
      return { chunk: "", nextCursor: 0, eof: false };
    }
    const cursor = input.cursor;
    const length = Math.min(size - cursor, input.maxBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, cursor);
    const atEof = cursor + length === size;
    // LOWER BOUND: never return a partial trailing line — it is mid-write, so
    // its '\n' has not arrived yet. Withhold it and keep the cursor put. The
    // only exceptions are reaching EOF on a finished run (where the residue is
    // all there will ever be) and a completely full read window, which PROVES
    // the current line is larger than the window: its '\n' can never surface
    // in this read, so withholding would deadlock the cursor forever (the
    // claude runner's single giant JSON object). Emit the whole window and let
    // the next poll continue from it.
    const lastNl = buffer.lastIndexOf(0x0a);
    if (lastNl < 0 && !(atEof && finished) && length !== input.maxBytes) {
      return { chunk: "", nextCursor: cursor, eof: false };
    }
    let end = lastNl < 0 ? buffer.length : lastNl + 1;
    if (lastNl < 0 && length === input.maxBytes) {
      // Slicing at a '\n' always lands on a character boundary (0x0A never
      // appears inside a multi-byte sequence), but the window edge is not so
      // safe: it can split a UTF-8 character, which would decode as U+FFFD and
      // desynchronise nextCursor from the bytes actually returned. Trim back
      // to the last complete character and advance only by what we give back.
      const untrimmedEnd = buffer.length;
      let continuations = 0;
      while (
        end > 0 &&
        end > untrimmedEnd - 3 &&
        (buffer[end - 1] & 0xc0) === 0x80
      ) {
        end -= 1;
        continuations += 1;
      }
      if (end > 0) {
        const lead = buffer[end - 1];
        const required =
          (lead & 0xe0) === 0xc0 ? 1 :
          (lead & 0xf0) === 0xe0 ? 2 :
          (lead & 0xf8) === 0xf0 ? 3 : 0;
        if (continuations < required) {
          // Incomplete trailing sequence: drop its lead byte too.
          end -= 1;
        } else {
          // A complete character ended exactly at the window edge: keep it.
          end = untrimmedEnd;
        }
      }
    }
    const returned = buffer.subarray(0, end);
    const nextCursor = cursor + returned.length;
    return {
      chunk: returned.toString("utf8"),
      nextCursor,
      eof: nextCursor === size && finished,
    };
  } catch {
    // Swallow fs errors like readLogTail does: a missing or race-deleted file
    // reads as an empty chunk, and the caller retries on the same cursor.
    return { chunk: "", nextCursor: input.cursor, eof: false };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
