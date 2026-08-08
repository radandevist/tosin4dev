import { describe, expect, it } from "vitest";
import type { Evidence, Ticket } from "../domain/schemas";
import { neutralizePrTokens, prBody } from "./supervisor.server";

// The zero-width space is written as an escape (not a raw byte) so the file
// stays readable and a trailing-whitespace cleanup cannot strip it silently.
const ZWSP = "\u200b";

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

  it("leaves an email address alone — GitHub never resolves it as a mention", () => {
    expect(neutralizePrTokens("reach me at t@example.com")).toBe(
      "reach me at t@example.com",
    );
    expect(neutralizePrTokens("both a@b and t@example.com stay")).toBe(
      "both a@b and t@example.com stay",
    );
  });

  it("leaves an @ handle that ends in a dotted TLD alone — it reads as an email", () => {
    expect(neutralizePrTokens("write to @gmail.com")).toBe("write to @gmail.com");
  });

  it("keeps @scope-style npm shorthand copy-pasteable — only a ZWSP is inserted", () => {
    const out = neutralizePrTokens("install npm i @types/node --save");
    // The @ is a genuine token start so it gets a ZWSP, but the scope reads
    // identically on the page and a copy of the command still works.
    expect(out).toBe(`install npm i @${ZWSP}types/node --save`);
  });

  it("leaves inline backtick spans and fenced code blocks untouched", () => {
    const span = "run `npm i @types/node` then Closes #12";
    const out = neutralizePrTokens(span);
    // The backtick span is untouched — the package scope stays copy-pasteable.
    expect(out).toContain("`npm i @types/node`");
    // The prose around it is still neutralized.
    expect(out).toContain(`Closes #${ZWSP}12`);

    const fence = [
      "```sh",
      "npm i @types/node",
      "# not a closing keyword inside code",
      "```",
      "after the fence ping @tosin4dev",
    ].join("\n");
    const fenceOut = neutralizePrTokens(fence);
    // The code itself is byte-identical — not even the leading # survived.
    expect(fenceOut).toContain("npm i @types/node");
    expect(fenceOut).toContain("# not a closing keyword inside code");
    expect(fenceOut).not.toContain("#\u200b not");
    // Prose after the fence is still neutralized.
    expect(fenceOut).toContain(`after the fence ping @${ZWSP}tosin4dev`);
  });

  it("breaks every closing form GitHub honours", () => {
    const cases: Array<[string, string]> = [
      // keyword + #N — the ZWSP sits between the # and the number
      ["Closes #123", `#${ZWSP}`],
      // colon form
      ["Closes: #12", `#${ZWSP}`],
      // all the keyword variants
      ["closes #123 and closes: #4", `#${ZWSP}`],
      ["Closed #123", `#${ZWSP}`],
      ["close #123", `#${ZWSP}`],
      ["Fix #456", `#${ZWSP}`],
      ["Fixes #78 and fixed #90", `#${ZWSP}`],
      ["Resolve #1", `#${ZWSP}`],
      ["Resolves #2", `#${ZWSP}`],
      ["Resolved #3", `#${ZWSP}`],
      // case-insensitive keyword
      ["FIXES #78", `#${ZWSP}`],
      ["CLOSED #5", `#${ZWSP}`],
      // shorthand GH-N — ZWSP goes after the dash
      ["Closes GH-123", `-${ZWSP}`],
      // cross-repo owner/repo#N — ZWSP goes between the # and the number
      ["Closes owner/repo#412", `#${ZWSP}`],
      // full issue URL — ZWSP goes after the last slash
      ["Closes https://github.com/owner/repo/issues/12", `/issues/${ZWSP}`],
    ];
    for (const [input, marker] of cases) {
      const out = neutralizePrTokens(input);
      expect(out, input).toContain(marker);
      expect(out).not.toBe(input);
    }
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
