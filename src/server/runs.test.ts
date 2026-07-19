import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DispatchRunInputSchema,
  LogTailInputSchema,
  RunDTOSchema,
} from "./runs";
import { readLogTail } from "./runs.server";
import { parseSummary } from "./supervisor.server";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("run browser contracts", () => {
  it("requires exact ObjectIds and rejects extra dispatch fields", () => {
    expect(
      DispatchRunInputSchema.safeParse({
        ticketId: "0123456789abcdef01234567",
        phase: "execute",
      }).success,
    ).toBe(true);
    expect(
      DispatchRunInputSchema.safeParse({
        ticketId: "not-an-object-id",
        phase: "execute",
      }).success,
    ).toBe(false);
    expect(
      DispatchRunInputSchema.safeParse({
        ticketId: "0123456789abcdef01234567",
        phase: "execute",
        status: "succeeded",
      }).success,
    ).toBe(false);
  });

  it("caps requested log tails and rejects extra fields", () => {
    expect(LogTailInputSchema.parse({ runId: "0123456789abcdef01234567" })).toEqual({
      runId: "0123456789abcdef01234567",
      bytes: 20_000,
    });
    expect(
      LogTailInputSchema.safeParse({
        runId: "0123456789abcdef01234567",
        bytes: 100_001,
      }).success,
    ).toBe(false);
    expect(
      LogTailInputSchema.safeParse({
        runId: "0123456789abcdef01234567",
        bytes: 20,
        path: "/tmp/secret",
      }).success,
    ).toBe(false);
  });

  it("validates a BSON-free RunDTO strictly", () => {
    const timestamp = "2026-07-19T12:00:00.000Z";
    const dto = {
      _id: "0123456789abcdef01234567",
      ticketId: "123456789abcdef012345678",
      boardId: "23456789abcdef0123456789",
      runner: "claude",
      phase: "execute",
      status: "running",
      workDir: "/tmp/worktree",
      promptFile: "/tmp/run/prompt.md",
      logFile: "/tmp/run/output.log",
      pid: 123,
      exitCode: null,
      summary: null,
      queuedAt: timestamp,
      startedAt: timestamp,
      finishedAt: null,
    };

    expect(RunDTOSchema.parse(dto)).toEqual(dto);
    expect(RunDTOSchema.safeParse({ ...dto, pid: "123" }).success).toBe(false);
    expect(RunDTOSchema.safeParse({ ...dto, bson: {} }).success).toBe(false);
  });
});

describe("SUMMARY parsing", () => {
  it.each([
    ["work done\nSUMMARY\nfirst\nsecond\n", "first\nsecond"],
    ["work done\r\n## SUMMARY\r\nfirst\r\nsecond\r\n", "first\nsecond"],
  ])("accepts plain and Markdown headers", (output, expected) => {
    expect(parseSummary(output)).toBe(expected);
  });

  it("uses the final summary and caps it at ten lines", () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    const output = `SUMMARY\nold\nnoise\n## SUMMARY\n${lines.join("\n")}`;
    expect(parseSummary(output)).toBe(lines.slice(0, 10).join("\n"));
  });

  it("returns null when there is no populated summary section", () => {
    expect(parseSummary("ordinary runner output")).toBeNull();
    expect(parseSummary("ordinary runner output\nSUMMARY\n")).toBeNull();
  });
});

describe("bounded log tail", () => {
  it("reads only the requested suffix and handles a missing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t4d-tail-"));
    temporaryDirectories.push(directory);
    const logFile = join(directory, "output.log");
    await writeFile(logFile, `${"x".repeat(1_000_000)}THE-END`);

    await expect(readLogTail(logFile, 16)).resolves.toBe("xxxxxxxxxTHE-END");
    await expect(readLogTail(join(directory, "missing.log"), 16)).resolves.toBe("");
  });
});
