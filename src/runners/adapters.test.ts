import { describe, expect, it } from "vitest";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import type { RunnerBrief } from "./types";

const brief = (over: Partial<RunnerBrief> = {}): RunnerBrief =>
  ({
    ticket: {} as never,
    board: {} as never,
    workDir: "/wt",
    phase: "execute",
    outcomePath: "/wt/o.json",
    ...over,
  });

describe("claude adapter", () => {
  it("uses json output on execute (for session capture)", () => {
    const c = claudeAdapter.buildCommand(brief(), "/p.md");
    expect(c.cmd).toContain("--output-format");
    expect(c.cmd).toContain("json");
  });
  it("adds --resume with the session id on a resume turn", () => {
    const c = claudeAdapter.buildCommand(
      brief({ resume: { sessionId: "s1", answer: "x" } }),
      "/p.md",
    );
    expect(c.cmd).toContain("--resume");
    expect(c.cmd).toContain("s1");
  });
});
describe("codex adapter", () => {
  it("uses --json on execute", () => {
    const c = codexAdapter.buildCommand(brief(), "/p.md");
    expect(c.cmd).toContain("--json");
  });
  it("uses exec resume <thread> on a resume turn", () => {
    const c = codexAdapter.buildCommand(
      brief({ resume: { sessionId: "t1", answer: "x" } }),
      "/p.md",
    );
    expect(c.cmd).toContain("resume");
    expect(c.cmd).toContain("t1");
  });
});
