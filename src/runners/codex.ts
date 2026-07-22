import type { RunnerAdapter } from "./types";

export const codexAdapter: RunnerAdapter = {
  name: "codex",
  buildCommand({ workDir, phase, resume }, promptFile) {
    if (phase === "spec_draft") {
      return {
        cmd: [
          "codex",
          "exec",
          "--sandbox",
          "read-only",
          "--cd",
          workDir,
          `Read ${promptFile} and follow it exactly. End with the required SUMMARY section.`,
        ],
        env: {},
      };
    }
    const prompt = `Read ${promptFile} and follow it exactly. Finish by writing the outcome JSON.`;
    // cwd + sandbox are ROOT-level flags (before `exec`) — required for `exec resume`.
    const root = ["codex", "-C", workDir, "-s", "workspace-write"];
    if (resume) {
      return {
        cmd: [...root, "exec", "resume", resume.sessionId, "--json", prompt],
        env: {},
      };
    }
    return { cmd: [...root, "exec", "--json", prompt], env: {} };
  },
};
