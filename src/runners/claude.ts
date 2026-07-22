import type { RunnerAdapter } from "./types";

export const claudeAdapter: RunnerAdapter = {
  name: "claude",
  buildCommand(brief, promptFile) {
    // spec_draft keeps plain text + the SUMMARY section; execute/review_fix use
    // JSON output so the supervisor can capture the session id.
    if (brief.phase === "spec_draft") {
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
    }
    const prompt = brief.resume
      ? `Read ${promptFile} and follow it exactly. It contains the human's answer to your question. Finish by writing the outcome JSON.`
      : `Read ${promptFile} and follow it exactly. Finish by writing the outcome JSON.`;
    const cmd = ["claude", "-p", prompt, "--output-format", "json"];
    if (brief.resume) cmd.push("--resume", brief.resume.sessionId);
    return { cmd, env: {} };
  },
};
