import type { Board, Run, Ticket } from "../domain/schemas";

export interface RunnerBrief {
  ticket: Ticket;
  board: Board;
  workDir: string;
  phase: Run["phase"];
}

export interface RunnerCommand {
  cmd: string[];
  env: Record<string, string>;
}

export interface RunnerAdapter {
  name: "claude" | "codex";
  buildCommand(brief: RunnerBrief, promptFile: string): RunnerCommand;
}
