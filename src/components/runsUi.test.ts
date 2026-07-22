import { describe, expect, it } from "vitest";
import {
  dispatchActionForTicket,
  formatRunTimestamp,
  isLiveRunStatus,
  isTerminalRunStatus,
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
