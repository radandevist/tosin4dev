import type { RunnerAdapter } from "./types";

export const codexAdapter: RunnerAdapter = {
  name: "codex",
  buildCommand({ workDir }, promptFile) {
    return {
      cmd: [
        "codex",
        "exec",
        "--sandbox",
        "workspace-write",
        "--cd",
        workDir,
        `Read ${promptFile} and follow it exactly. End with the required SUMMARY section.`,
      ],
      env: {},
    };
  },
};
