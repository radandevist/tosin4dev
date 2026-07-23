import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { InputExchangeSchema, RunSchema } from "../domain/schemas";
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

  it("defaults a genuinely absent exchanges key without dropping sibling runs", async () => {
    const ticketId = new ObjectId().toString();
    const run = RunSchema.parse({
      ticketId,
      boardId: new ObjectId().toString(),
      runner: "claude",
      phase: "execute",
      status: "running",
      workDir: "/repo/.tosin4dev/worktrees/legacy",
      promptFile: "/repo/.tosin4dev/runs/legacy/prompt.md",
      logFile: "/repo/.tosin4dev/runs/legacy/output.log",
    });
    const { exchanges: _exchanges, ...legacyRun } = run;
    const legacyId = new ObjectId();
    const siblingId = new ObjectId();
    mockState.docs = [
      {
        _id: legacyId,
        ...legacyRun,
        pid: 101,
        queuedAt: "2026-07-22T10:00:00.000Z",
        startedAt: "2026-07-22T10:00:01.000Z",
        finishedAt: null,
      },
      {
        _id: siblingId,
        ...run,
        pid: 102,
        queuedAt: "2026-07-22T10:01:00.000Z",
        startedAt: "2026-07-22T10:01:01.000Z",
        finishedAt: null,
      },
    ];

    const listed = await listRunsCore({ ticketId });

    expect(listed).toHaveLength(2);
    expect(listed.find(({ _id }) => _id === legacyId.toString())?.exchanges)
      .toEqual([]);
    expect(listed.some(({ _id }) => _id === siblingId.toString())).toBe(true);
  });

  it("drops an invalid exchange row without dropping valid history or sibling runs", async () => {
    const ticketId = new ObjectId().toString();
    const run = RunSchema.parse({
      ticketId,
      boardId: new ObjectId().toString(),
      runner: "codex",
      phase: "execute",
      status: "awaiting_input",
      workDir: "/repo/.tosin4dev/worktrees/mixed",
      promptFile: "/repo/.tosin4dev/runs/mixed/prompt.md",
      logFile: "/repo/.tosin4dev/runs/mixed/output.log",
      awaitingQuestion: "Which database?",
    });
    const validExchange = InputExchangeSchema.parse({
      v: 1,
      at: "2026-07-22T10:02:00.000Z",
      question: "Which database?",
    });
    const mixedId = new ObjectId();
    const siblingId = new ObjectId();
    mockState.docs = [
      {
        _id: mixedId,
        ...run,
        exchanges: [validExchange, { ...validExchange, v: 2 }],
        pid: null,
        queuedAt: "2026-07-22T10:00:00.000Z",
        startedAt: "2026-07-22T10:00:01.000Z",
        finishedAt: null,
      },
      {
        _id: siblingId,
        ...run,
        exchanges: [],
        pid: null,
        queuedAt: "2026-07-22T10:01:00.000Z",
        startedAt: "2026-07-22T10:01:01.000Z",
        finishedAt: null,
      },
    ];

    const listed = await listRunsCore({ ticketId });

    expect(listed).toHaveLength(2);
    expect(listed.find(({ _id }) => _id === mixedId.toString())?.exchanges)
      .toEqual([validExchange]);
    expect(listed.some(({ _id }) => _id === siblingId.toString())).toBe(true);
  });
});
