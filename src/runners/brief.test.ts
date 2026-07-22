import { describe, expect, it } from "vitest";
import type { Board, Ticket } from "../domain/schemas";
import { buildPrompt } from "./brief";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";

const ticket: Ticket = {
  boardId: "0123456789abcdef01234567",
  seq: 7,
  title: "Fix docs",
  type: "implement",
  status: "approved",
  runner: "claude",
  spec: {
    intent: "Remove expiry job",
    scope: "docs/",
    nonGoals: "application code",
    acceptance: ["doc updated", "links checked"],
    links: [],
    risk: "low",
    approvedAt: "2026-07-19T12:00:00.000Z",
    approvedBy: "radan",
  },
  activeRunId: null,
  prUrl: null,
  activity: [],
};

const board: Board = {
  slug: "publyapp",
  name: "PublyApp",
  repoPath: "/repo",
  defaultBaseBranch: "develop",
  checks: [],
};

const executablePhases: ("execute" | "review_fix")[] = [
  "execute",
  "review_fix",
];

describe("buildPrompt", () => {
  it.each(executablePhases)(
    "%s brief pins the worktree, scope, non-goals, and acceptance order",
    (phase) => {
      const prompt = buildPrompt({
        ticket,
        board,
        workDir: "/wt/7",
        phase,
      });

      expect(prompt).toContain("Work directory (isolated git worktree): /wt/7");
      expect(prompt).toContain("Scope (only touch these): docs/");
      expect(prompt).toContain(
        "Non-goals (must NOT change): application code",
      );
      expect(prompt).toContain(
        "Acceptance criteria:\n1. doc updated\n2. links checked",
      );
      expect(prompt).toContain("Links:\nnone");
      expect(prompt).toContain("do not push");
    },
  );

  it("instructs the runner to write outcome.json on execute", () => {
    const text = buildPrompt({
      ticket,
      board,
      workDir: "/wt",
      phase: "execute",
      outcomePath: "/r/outcome.json",
    });
    expect(text).toContain("/r/outcome.json");
    expect(text).toContain('"outcome"');
  });

  it("carries the human answer on a resume turn", () => {
    const text = buildPrompt({
      ticket,
      board,
      workDir: "/wt",
      phase: "execute",
      outcomePath: "/r/outcome.json",
      resume: { sessionId: "s1", answer: "use lucia" },
    });
    expect(text).toContain("use lucia");
  });

  it("uses explicit fallbacks for an underspecified execution brief", () => {
    const prompt = buildPrompt({
      ticket: {
        ...ticket,
        spec: {
          ...ticket.spec,
          scope: "",
          nonGoals: "",
          acceptance: [],
          links: ["https://example.com/ticket/7"],
        },
      },
      board,
      workDir: "/wt/7",
      phase: "execute",
    });

    expect(prompt).toContain("unspecified — stay minimal");
    expect(prompt).toContain("Non-goals (must NOT change): none");
    expect(prompt).toContain("Acceptance criteria:\nnone provided");
    expect(prompt).toContain("Links:\nhttps://example.com/ticket/7");
  });

  it("makes spec drafting read-only and identifies the repo base branch", () => {
    const prompt = buildPrompt({
      ticket,
      board,
      workDir: "/unused",
      phase: "spec_draft",
    });

    expect(prompt).toContain("Repo: /repo (base branch: develop)");
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("Do not modify any file");
    expect(prompt).toContain(
      "Acceptance criteria:\n1. doc updated\n2. links checked",
    );
    expect(prompt).toContain("SUMMARY");
    expect(prompt).not.toContain("/unused");
  });
});

describe("runner adapters", () => {
  it("builds a safe Claude structured command without environment overrides", () => {
    const command = claudeAdapter.buildCommand(
      { ticket, board, workDir: "/wt/7", phase: "execute" },
      "/wt/7/.tosin/prompt.md",
    );

    expect(claudeAdapter.name).toBe("claude");
    expect(command).toEqual({
      cmd: [
        "claude",
        "-p",
        "Read /wt/7/.tosin/prompt.md and follow it exactly. Finish by writing the outcome JSON.",
        "--output-format",
        "json",
      ],
      env: {},
    });
    expect(command.cmd).not.toContain("--dangerously-skip-permissions");
    expect(command.cmd).not.toContain("--yolo");
  });

  it("builds a read-only Codex spec command in the board repo", () => {
    const command = codexAdapter.buildCommand(
      { ticket, board, workDir: board.repoPath, phase: "spec_draft" },
      "/repo/.tosin/prompt.md",
    );

    expect(codexAdapter.name).toBe("codex");
    expect(command).toEqual({
      cmd: [
        "codex",
        "exec",
        "--sandbox",
        "read-only",
        "--cd",
        "/repo",
        "Read /repo/.tosin/prompt.md and follow it exactly. End with the required SUMMARY section.",
      ],
      env: {},
    });
    expect(command.cmd).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(command.cmd).not.toContain("--yolo");
  });

  it.each(executablePhases)(
    "builds a safe Codex workspace-write %s command without environment leakage",
    (phase) => {
      const command = codexAdapter.buildCommand(
        { ticket, board, workDir: "/wt/7", phase },
        "/wt/7/.tosin/prompt.md",
      );

      expect(command).toEqual({
        cmd: [
          "codex",
          "-C",
          "/wt/7",
          "-s",
          "workspace-write",
          "exec",
          "--json",
          "Read /wt/7/.tosin/prompt.md and follow it exactly. Finish by writing the outcome JSON.",
        ],
        env: {},
      });
    },
  );
});
