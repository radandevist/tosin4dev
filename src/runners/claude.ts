import type { RunnerAdapter } from "./types";

export const claudeAdapter: RunnerAdapter = {
  name: "claude",
  buildCommand(_brief, promptFile) {
    return {
      cmd: [
        "claude",
        "-p",
        `Read ${promptFile} and follow it exactly. End with the required SUMMARY section.`,
        "--output-format",
        "text",
      ],
      env: {},
    };
  },
};
