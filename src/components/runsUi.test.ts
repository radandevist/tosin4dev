import { describe, expect, it } from "vitest";
import type { InputExchange } from "../domain/schemas";
import { RunDTOSchema } from "../server/runs";
import {
  answeredExchanges,
  dispatchActionForTicket,
  formatRunTimestamp,
  isLiveRunStatus,
  isTicketAdvancingRunStatus,
  isTerminalRunStatus,
  openExchange,
  shouldShowAnswerForm,
  shouldPollRun,
  shouldPollLog,
} from "./runsUi";

describe("dispatchActionForTicket", () => {
  it("offers spec drafting only for an idle inbox ticket", () => {
    expect(dispatchActionForTicket("inbox", "claude", null)).toEqual({
      label: "Draft spec with Claude",
      phase: "spec_draft",
    });
    expect(
      dispatchActionForTicket("inbox", "claude", "507f1f77bcf86cd799439011"),
    ).toBeNull();
  });

  it("offers Run now only for an idle approved ticket", () => {
    expect(dispatchActionForTicket("approved", "codex", null)).toEqual({
      label: "Run now",
      phase: "execute",
    });
    expect(
      dispatchActionForTicket("approved", "codex", "507f1f77bcf86cd799439011"),
    ).toBeNull();
  });

  it("offers no dispatch for every other ticket state", () => {
    expect(dispatchActionForTicket("spec_review", "claude", null)).toBeNull();
    expect(dispatchActionForTicket("running", "claude", null)).toBeNull();
    expect(dispatchActionForTicket("blocked", "claude", null)).toBeNull();
    expect(dispatchActionForTicket("review_ready", "claude", null)).toBeNull();
    expect(dispatchActionForTicket("done", "claude", null)).toBeNull();
    expect(dispatchActionForTicket("archived", "claude", null)).toBeNull();
  });
});

describe("run polling helpers", () => {
  it("classifies only queued and running runs as live", () => {
    expect(isLiveRunStatus("queued")).toBe(true);
    expect(isLiveRunStatus("running")).toBe(true);
    expect(isLiveRunStatus("awaiting_input")).toBe(false);
    expect(isLiveRunStatus("verifying")).toBe(false);
    expect(isLiveRunStatus("succeeded")).toBe(false);
    expect(isLiveRunStatus("failed")).toBe(false);
    expect(isLiveRunStatus("blocked")).toBe(false);
    expect(isLiveRunStatus("cancelled")).toBe(false);
  });

  it("classifies only completed run states as terminal", () => {
    expect(isTerminalRunStatus("queued")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("awaiting_input")).toBe(false);
    expect(isTerminalRunStatus("verifying")).toBe(false);
    expect(isTerminalRunStatus("succeeded")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("blocked")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
  });

  it("polls runs only while they can advance autonomously", () => {
    expect(shouldPollRun("queued")).toBe(true);
    expect(shouldPollRun("running")).toBe(true);
    expect(shouldPollRun("verifying")).toBe(true);
    expect(shouldPollRun("awaiting_input")).toBe(false);
    expect(shouldPollRun("succeeded")).toBe(false);
    expect(shouldPollRun("failed")).toBe(false);
    expect(shouldPollRun("blocked")).toBe(false);
    expect(shouldPollRun("cancelled")).toBe(false);
  });

  it("invalidates ticket queries when a run parks or terminates", () => {
    expect(isTicketAdvancingRunStatus("queued")).toBe(false);
    expect(isTicketAdvancingRunStatus("running")).toBe(false);
    expect(isTicketAdvancingRunStatus("verifying")).toBe(false);
    expect(isTicketAdvancingRunStatus("awaiting_input")).toBe(true);
    expect(isTicketAdvancingRunStatus("succeeded")).toBe(true);
    expect(isTicketAdvancingRunStatus("failed")).toBe(true);
    expect(isTicketAdvancingRunStatus("blocked")).toBe(true);
    expect(isTicketAdvancingRunStatus("cancelled")).toBe(true);
  });

  it("polls a selected log until its run is known to be terminal", () => {
    expect(shouldPollLog(null, undefined)).toBe(false);
    expect(shouldPollLog("507f1f77bcf86cd799439011", undefined)).toBe(true);
    expect(shouldPollLog("507f1f77bcf86cd799439011", "running")).toBe(true);
    expect(shouldPollLog("507f1f77bcf86cd799439011", "succeeded")).toBe(false);
  });
});

describe("formatRunTimestamp", () => {
  it("renders a stable minute-precision UTC timestamp", () => {
    expect(formatRunTimestamp("2026-07-19T14:05:36.123Z")).toBe(
      "2026-07-19 14:05 UTC",
    );
  });
});

describe("input exchange helpers", () => {
  const at = "2026-07-23T10:00:00.000Z";
  const open: InputExchange = {
    v: 1,
    at,
    question: "Which base branch?",
    handoff: null,
    answer: null,
    answeredAt: null,
  };
  const answered = (question: string, answer: string): InputExchange => ({
    ...open,
    question,
    answer,
    answeredAt: "2026-07-23T10:05:00.000Z",
  });

  it("handles an empty history", () => {
    expect(answeredExchanges([])).toEqual([]);
    expect(openExchange([])).toBeNull();
  });

  it("returns one open exchange", () => {
    expect(answeredExchanges([open])).toEqual([]);
    expect(openExchange([open])).toBe(open);
  });

  it("splits two answered exchanges from the open exchange", () => {
    const first = answered("Question one?", "Answer one");
    const second = answered("Question two?", "Answer two");
    const history = [first, second, open];

    expect(answeredExchanges(history)).toEqual([first, second]);
    expect(openExchange(history)).toBe(open);
  });

  it("returns no open exchange when all are answered", () => {
    const history = [
      answered("Question one?", "Answer one"),
      answered("Question two?", "Answer two"),
    ];

    expect(answeredExchanges(history)).toEqual(history);
    expect(openExchange(history)).toBeNull();
  });

  it("returns the last open exchange from malformed legacy history", () => {
    const lastOpen = { ...open, question: "Latest question?" };

    expect(openExchange([open, lastOpen])).toBe(lastOpen);
  });
});

describe("shouldShowAnswerForm", () => {
  const parkedRun = RunDTOSchema.parse({
    _id: "0123456789abcdef01234567",
    ticketId: "123456789abcdef012345678",
    boardId: "23456789abcdef0123456789",
    runner: "claude",
    phase: "execute",
    status: "awaiting_input",
    workDir: "/tmp/worktree",
    promptFile: "/tmp/run/prompt.md",
    logFile: "/tmp/run/output.log",
    stderrFile: null,
    pid: null,
    exitCode: null,
    summary: null,
    awaitingQuestion: "Which base branch?",
    exchanges: [],
    exchangesDropped: 0,
    queuedAt: "2026-07-23T10:00:00.000Z",
    startedAt: "2026-07-23T10:00:01.000Z",
    finishedAt: null,
  });

  it("shows the form for a legacy parked run without exchanges", () => {
    expect(shouldShowAnswerForm(parkedRun)).toBe(true);
  });

  it("shows the form for a parked run with populated history", () => {
    expect(
      shouldShowAnswerForm({
        ...parkedRun,
        exchanges: [
          {
            v: 1,
            at: "2026-07-23T10:02:00.000Z",
            question: "Which base branch?",
            handoff: null,
            answer: "develop",
            answeredAt: "2026-07-23T10:03:00.000Z",
          },
        ],
      }),
    ).toBe(true);
  });

  it("hides the form when there is no parked run", () => {
    expect(shouldShowAnswerForm(undefined)).toBe(false);
  });

  it("hides the form for a continued-park run", () => {
    expect(shouldShowAnswerForm({ ...parkedRun, parkedBy: "continued" })).toBe(false);
  });

  it("shows the form for a question-park run", () => {
    expect(shouldShowAnswerForm({ ...parkedRun, parkedBy: "question" })).toBe(true);
  });

  it("shows the form for a legacy run without parkedBy (defaults to question)", () => {
    // The schema default for parkedBy is "question". A RunDTOSchema.parse of a
    // doc without parkedBy hydrates it as "question" via the zod default.
    const legacy = { ...parkedRun } as Record<string, unknown>;
    delete (legacy as { parkedBy?: string }).parkedBy;
    const parsed = RunDTOSchema.parse(legacy);
    expect(parsed.parkedBy).toBe("question");
    expect(shouldShowAnswerForm(parsed)).toBe(true);
  });
});
