import { describe, expect, it } from "vitest";
import type { Evidence, Ticket } from "../domain/schemas";
import { neutralizePrTokens, prBody } from "./supervisor.server";

const ZWSP = "​";

const TICKET: Ticket = {
  boardId: "0123456789abcdef01234567",
  seq: 1,
  title: "confetti",
  type: "implement",
  status: "approved",
  runner: "claude",
  spec: {
    intent: "make confetti",
    scope: "",
    nonGoals: "",
    acceptance: [],
    links: [],
    risk: "low",
    approvedAt: "2026-08-07T00:00:00.000Z",
    approvedBy: "radan",
  },
  activeRunId: null,
  prUrl: null,
  activity: [],
  dependsOn: [],
};

const EVIDENCE: Evidence = {
  runId: "0123456789abcdef01234567",
  ticketId: "0123456789abcdef01234567",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  commitRef: "tosin4dev/run/abc",
  checks: [],
  verdict: "passed",
  createdAt: "2026-08-07T00:00:00.000Z",
};

describe("neutralizePrTokens", () => {
  it("breaks @mentions so the PR body cannot mass-notify a user", () => {
    const out = neutralizePrTokens("ping @tosin4dev and @radan for review");
    expect(out).not.toContain("@tosin4dev");
    expect(out).not.toContain("@radan");
    // The handle stays readable: the zero-width space sits between `@` and the
    // name, so the token no longer resolves but the text still reads normally.
    expect(out).toContain(`@${ZWSP}tosin4dev`);
    expect(out).toContain(`@${ZWSP}radan`);
  });

  it("breaks closing keywords so a merge cannot auto-close an unrelated issue", () => {
    const out = neutralizePrTokens("Closes #123 and fixes #45 on merge");
    expect(out).not.toMatch(/closes\s+#123/i);
    expect(out).not.toMatch(/fixes\s+#45/i);
    expect(out).toContain(`#${ZWSP}123`);
    expect(out).toContain(`#${ZWSP}45`);
  });

  it("leaves already-neutralized text untouched", () => {
    const plain = "a plain description with no control tokens";
    expect(neutralizePrTokens(plain)).toBe(plain);
  });
});

describe("prBody", () => {
  it("renders the neutralized spec into the body", () => {
    const body = prBody(
      {
        ...TICKET,
        spec: {
          ...TICKET.spec,
          intent: "do it for @tosin4dev",
          acceptance: ["Closes #99 when done"],
        },
      },
      EVIDENCE,
      "summary mentions @radan fixes #7",
    );
    expect(body).toContain("### Intent\n" + `do it for @${ZWSP}tosin4dev`);
    expect(body).toContain(`- Closes #${ZWSP}99 when done`);
    expect(body).toContain(`### Summary\nsummary mentions @${ZWSP}radan fixes #${ZWSP}7`);
  });

  it("keeps the evidence section to key and exitCode only — check output never leaks", () => {
    const body = prBody(
      {
        ...TICKET,
        spec: {
          ...TICKET.spec,
          intent: "verify something",
        },
      },
      {
        ...EVIDENCE,
        checks: [
          {
            key: "ok",
            // The full command and the output ref are evidence internals; the
            // public PR body must publish only the key and the exit code.
            command: ["echo", "secret-internal-output"],
            exitCode: 0,
            outputRef: "runs/abc/checks/ok.log",
            passedAt: "2026-08-07T00:00:00.000Z",
          },
        ],
      },
      null,
    );
    expect(body).toContain("### Verification");
    expect(body).toContain("`ok` — exit 0");
    expect(body).not.toContain("secret-internal-output");
    expect(body).not.toContain("ok.log");
  });
});
