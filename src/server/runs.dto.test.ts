import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { RunSchema } from "../domain/schemas";
import { RunDTOSchema } from "./runs";

const mockState = vi.hoisted(() => ({ docs: [] as unknown[] }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    db: async () => ({
      collection: () => ({
        find: () => ({
          sort: () => ({ toArray: async () => mockState.docs }),
        }),
      }),
    }),
  };
});

const { listRunsCore } = await import("./runs.server");

describe("run DTO mapping", () => {
  it("maps a full awaiting-input run without leaking persistence fields", async () => {
    const ticketId = new ObjectId().toString();
    const run = RunSchema.parse({
      ticketId,
      boardId: new ObjectId().toString(),
      runner: "claude",
      phase: "execute",
      status: "awaiting_input",
      workDir: "/repo/.tosin4dev/worktrees/run",
      promptFile: "/repo/.tosin4dev/runs/run/prompt.md",
      logFile: "/repo/.tosin4dev/runs/run/output.log",
      awaitingQuestion: "Which authentication library should I use?",
    });
    mockState.docs = [
      {
        _id: new ObjectId(),
        ...run,
        pid: null,
        queuedAt: "2026-07-22T10:00:00.000Z",
        startedAt: "2026-07-22T10:00:01.000Z",
        finishedAt: null,
      },
    ];

    const [dto] = await listRunsCore({ ticketId });

    expect(RunDTOSchema.parse(dto)).toEqual(dto);
    expect(dto.awaitingQuestion).toBe(
      "Which authentication library should I use?",
    );
    expect(dto).not.toHaveProperty("branch");
  });
});
