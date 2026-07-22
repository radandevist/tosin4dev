import { describe, it, expect } from "vitest";
import {
  BoardSchema,
  CreateTicketInputSchema,
  RunSchema,
  SetRunnerInputSchema,
  SpecInputSchema,
  SpecSchema,
  TicketSchema,
  TicketStatus,
  TicketType,
} from "./schemas";

// Valid serialized ObjectIds (24 hex chars) for use across the fixtures.
const BOARD_ID = "0123456789abcdef01234567";
const TICKET_ID = "89abcdef0123456789abcdef";

describe("schemas", () => {
  describe("BoardSchema.checks", () => {
    const base = {
      slug: "publyapp",
      name: "PublyApp",
      repoPath: "/home/radan/Projects/PublyApp/publyapp",
      defaultBaseBranch: "develop",
    };
    it("defaults checks to an empty array", () => {
      const board = BoardSchema.parse(base);
      expect(board.checks).toEqual([]);
    });
    it("accepts argv checks with a timeout", () => {
      const board = BoardSchema.parse({
        ...base,
        checks: [
          { key: "typecheck", label: "Typecheck", command: ["bun", "run", "typecheck"], timeoutMs: 120000 },
        ],
      });
      expect(board.checks[0].command).toEqual(["bun", "run", "typecheck"]);
    });
    it("rejects a check with an empty command", () => {
      expect(() =>
        BoardSchema.parse({
          ...base,
          checks: [{ key: "x", label: "X", command: [], timeoutMs: 1000 }],
        }),
      ).toThrow();
    });
  });

  it("accepts a minimal valid ticket", () => {
    const t = TicketSchema.parse({
      boardId: BOARD_ID,
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
        boardId: BOARD_ID,
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
      ticketId: TICKET_ID,
      boardId: BOARD_ID,
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
      boardId: BOARD_ID,
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
    expect(t.spec.approvedBy).toBeNull();
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
        boardId: BOARD_ID,
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
        boardId: BOARD_ID,
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

describe("input schemas (client boundary)", () => {
  const validSpecInput = {
    intent: "Add rate limiting",
    scope: "the login route",
    nonGoals: "no global throttling",
    acceptance: ["429 after N attempts"],
    links: [],
    risk: "medium" as const,
  };

  it("accepts a fully specified create payload", () => {
    const parsed = CreateTicketInputSchema.parse({
      boardId: BOARD_ID,
      title: "Rate limit login",
      type: "implement",
      runner: "claude",
      spec: validSpecInput,
    });
    expect(parsed.spec.scope).toBe("the login route");
  });

  it("rejects server-owned fields on the create payload (strict)", () => {
    expect(() =>
      CreateTicketInputSchema.parse({
        boardId: BOARD_ID,
        title: "Sneaky",
        type: "implement",
        runner: "claude",
        spec: validSpecInput,
        status: "approved",
        activeRunId: TICKET_ID,
      }),
    ).toThrow();
  });

  it("rejects approvedAt smuggled into a spec input (strict)", () => {
    expect(() =>
      SpecInputSchema.parse({
        ...validSpecInput,
        approvedAt: new Date(0).toISOString(),
      }),
    ).toThrow();
  });

  it("rejects approvedBy smuggled into a spec input (strict)", () => {
    expect(() =>
      SpecInputSchema.parse({ ...validSpecInput, approvedBy: "radan" }),
    ).toThrow();
  });

  it("defaults persisted spec approval metadata to null and pins approvedBy to radan", () => {
    const spec = SpecSchema.parse({ intent: "ship" });
    expect(spec.approvedAt).toBeNull();
    expect(spec.approvedBy).toBeNull();
    expect(
      SpecSchema.safeParse({ intent: "ship", approvedBy: "radan" }).success,
    ).toBe(true);
    expect(
      SpecSchema.safeParse({ intent: "ship", approvedBy: "someone-else" })
        .success,
    ).toBe(false);
  });

  it("rejects a spec input that omits a required field", () => {
    const withoutScope = {
      intent: validSpecInput.intent,
      nonGoals: validSpecInput.nonGoals,
      acceptance: validSpecInput.acceptance,
      links: validSpecInput.links,
      risk: validSpecInput.risk,
    };
    expect(() => SpecInputSchema.parse(withoutScope)).toThrow();
  });

  it("rejects an invalid ObjectId on the create payload", () => {
    expect(() =>
      CreateTicketInputSchema.parse({
        boardId: "b1",
        title: "Bad id",
        type: "implement",
        runner: "claude",
        spec: validSpecInput,
      }),
    ).toThrow();
  });
});

describe("setRunner input schema (client boundary)", () => {
  const TICKET = "89abcdef0123456789abcdef";

  it("accepts a valid ticketId + runner", () => {
    const parsed = SetRunnerInputSchema.parse({
      ticketId: TICKET,
      runner: "codex",
    });
    expect(parsed.runner).toBe("codex");
  });

  it("rejects an unknown runner", () => {
    expect(() =>
      SetRunnerInputSchema.parse({ ticketId: TICKET, runner: "gemini" }),
    ).toThrow();
  });

  it("rejects an invalid ticket ObjectId", () => {
    expect(() =>
      SetRunnerInputSchema.parse({ ticketId: "nope", runner: "claude" }),
    ).toThrow();
  });

  it("rejects extra keys (strict)", () => {
    expect(() =>
      SetRunnerInputSchema.parse({
        ticketId: TICKET,
        runner: "claude",
        status: "running",
      }),
    ).toThrow();
  });
});

describe("host-path and PR-url guards", () => {
  it("rejects a relative board repoPath", () => {
    expect(() =>
      BoardSchema.parse({
        slug: "web",
        name: "Web",
        repoPath: "relative/repo",
        defaultBaseBranch: "main",
      }),
    ).toThrow();
  });

  it("rejects a relative run workDir", () => {
    expect(() =>
      RunSchema.parse({
        ticketId: TICKET_ID,
        boardId: BOARD_ID,
        runner: "codex",
        phase: "execute",
        status: "queued",
        workDir: "w",
        promptFile: "/w/p.md",
        logFile: "/w/log.txt",
      }),
    ).toThrow();
  });

  it("accepts a Windows absolute path", () => {
    const board = BoardSchema.parse({
      slug: "win",
      name: "Win",
      repoPath: "C:\\repos\\app",
      defaultBaseBranch: "main",
    });
    expect(board.repoPath).toBe("C:\\repos\\app");
  });

  it("rejects a non-http PR url scheme", () => {
    expect(() =>
      TicketSchema.parse({
        boardId: BOARD_ID,
        seq: 5,
        title: "js scheme",
        type: "implement",
        status: "review_ready",
        runner: "claude",
        spec: { intent: "ship it" },
        prUrl: "javascript:alert(1)",
      }),
    ).toThrow();
  });

  it("accepts an https PR url", () => {
    const t = TicketSchema.parse({
      boardId: BOARD_ID,
      seq: 6,
      title: "good pr",
      type: "implement",
      status: "review_ready",
      runner: "claude",
      spec: { intent: "ship it" },
      prUrl: "https://github.com/o/r/pull/1",
    });
    expect(t.prUrl).toBe("https://github.com/o/r/pull/1");
  });
});
