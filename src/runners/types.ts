import type { Board, Ticket } from "../domain/schemas";

export interface RunnerBrief {
  ticket: Ticket;
  board: Board;
  workDir: string;
  phase: "spec_draft" | "execute" | "review_fix";
}

export interface RunnerCommand {
  cmd: string[];
  env: Record<string, string>;
}

export interface RunnerAdapter {
  name: "claude" | "codex";
  buildCommand(brief: RunnerBrief, promptFile: string): RunnerCommand;
}
