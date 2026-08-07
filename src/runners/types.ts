import type { Board, Run, Ticket } from "../domain/schemas";

export interface RunnerBrief {
  ticket: Ticket;
  board: Board;
  workDir: string;
  phase: Run["phase"];
  // Absolute path the runner must write its outcome JSON to (execute/review_fix).
  outcomePath?: string;
  // Absolute path a spec_draft runner must write its structured spec to.
  specPath?: string;
  // Present on a resume turn: the captured session id + the human's answer.
  resume?: { sessionId: string; answer: string };
}

export interface RunnerCommand {
  cmd: string[];
  env: Record<string, string>;
}

export interface RunnerAdapter {
  name: "claude" | "codex";
  buildCommand(brief: RunnerBrief, promptFile: string): RunnerCommand;
}
