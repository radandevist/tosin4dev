import { describe, it, expect } from "vitest";
import {
  BoardSchema,
  RunSchema,
  TicketSchema,
  TicketStatus,
  TicketType,
} from "./schemas";

describe("schemas", () => {
  it("accepts a minimal valid ticket", () => {
    const t = TicketSchema.parse({
      boardId: "b1",
      seq: 1,
      title: "Fix invitation docs",
      type: "implement",
      status: "inbox",
      runner: "claude",
      spec: { intent: "Remove the expiry background job from docs" },
    });
    expect(t.spec.risk).toBe("low");
    expect(t.status).toBe("inbox");
  });

  it("rejects a bad board slug", () => {
    expect(() =>
      BoardSchema.parse({
        slug: "Bad Slug",
        name: "x",
        repoPath: "/tmp",
        defaultBaseBranch: "main",
      }),
    ).toThrow();
  });

  it("rejects an empty acceptance-less spec intent", () => {
    expect(() =>
      TicketSchema.parse({
        boardId: "b1",
        seq: 1,
        title: "x",
        type: "implement",
        status: "inbox",
        runner: "codex",
        spec: { intent: "" },
      }),
    ).toThrow();
  });

  it("accepts a run with defaults", () => {
    const r = RunSchema.parse({
      ticketId: "t1",
      boardId: "b1",
      runner: "codex",
      phase: "execute",
      status: "queued",
      workDir: "/w",
      promptFile: "/w/p.md",
      logFile: "/w/log.txt",
    });
    expect(r.exitCode).toBeNull();
  });

  it("applies embedded spec defaults", () => {
    const t = TicketSchema.parse({
      boardId: "b1",
      seq: 3,
      title: "Defaults check",
      type: "research",
      status: "inbox",
      runner: "claude",
      spec: { intent: "Investigate flaky test" },
    });
    expect(t.spec.scope).toBe("");
    expect(t.spec.nonGoals).toBe("");
    expect(t.spec.acceptance).toEqual([]);
    expect(t.spec.links).toEqual([]);
    expect(t.spec.approvedAt).toBeNull();
    expect(t.activeRunId).toBeNull();
    expect(t.prUrl).toBeNull();
    expect(t.activity).toEqual([]);
  });

  it("rejects an unknown ticket type and status", () => {
    expect(() => TicketType.parse("deploy")).toThrow();
    expect(() => TicketStatus.parse("in_progress")).toThrow();
  });

  it("rejects a non-URL prUrl", () => {
    expect(() =>
      TicketSchema.parse({
        boardId: "b1",
        seq: 4,
        title: "Bad PR link",
        type: "implement",
        status: "review_ready",
        runner: "claude",
        spec: { intent: "ship it" },
        prUrl: "not-a-url",
      }),
    ).toThrow();
  });

  it("rejects a non-positive ticket seq", () => {
    expect(() =>
      TicketSchema.parse({
        boardId: "b1",
        seq: 0,
        title: "Zero seq",
        type: "implement",
        status: "inbox",
        runner: "claude",
        spec: { intent: "x" },
      }),
    ).toThrow();
  });
});
