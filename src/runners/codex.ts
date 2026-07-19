import type { RunnerAdapter } from "./types";

export const codexAdapter: RunnerAdapter = {
  name: "codex",
  buildCommand({ workDir, phase }, promptFile) {
    return {
      cmd: [
        "codex",
        "exec",
        "--sandbox",
        phase === "spec_draft" ? "read-only" : "workspace-write",
        "--cd",
        workDir,
        `Read ${promptFile} and follow it exactly. End with the required SUMMARY section.`,
      ],
      env: {},
    };
  },
};
