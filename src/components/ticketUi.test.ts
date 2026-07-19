import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { APPROVED_MESSAGE, gatesForStatus } from "./GateButtons";
import { RiskLabel } from "./TicketCard";
import {
  BoardDependencyNotice,
  parseAcceptanceLines,
} from "../routes/b/$boardSlug/new";
import { DEFAULT_BOARD } from "../routes/index";
import { transition } from "../domain/stateMachine";
import { TicketStatus } from "../domain/schemas";

describe("gatesForStatus", () => {
  it("only exposes gates whose event is a legal transition from that status", () => {
    for (const status of TicketStatus.options) {
      for (const gate of gatesForStatus(status)) {
        // A gate button must never offer an event the state machine rejects.
        expect(() => transition(status, gate.event)).not.toThrow();
      }
    }
  });

  it("exposes human gates for exactly the four decision states", () => {
    const withGates = TicketStatus.options.filter(
      (status) => gatesForStatus(status).length > 0,
    );
    expect(withGates.sort()).toEqual(
      ["blocked", "inbox", "review_ready", "spec_review"].sort(),
    );
  });

  it("does not expose a button for approved (explanatory only)", () => {
    expect(gatesForStatus("approved")).toEqual([]);
  });

  it("tells the operator to dispatch approved work with the Run button", () => {
    expect(APPROVED_MESSAGE).toMatch(/Run button/);
    expect(APPROVED_MESSAGE).toMatch(/manually/);
  });
});

describe("Task 5 presentation defaults", () => {
  it("defaults new boards to the develop base branch", () => {
    expect(DEFAULT_BOARD.defaultBaseBranch).toBe("develop");
  });

  it("renders ticket risk as visible text", () => {
    const html = renderToStaticMarkup(
      createElement(RiskLabel, { risk: "high" }),
    );
    expect(html).toContain("High risk");
  });

  it("reports dependent board loading and errors in the panel", () => {
    const loading = renderToStaticMarkup(
      createElement(BoardDependencyNotice, {
        isPending: true,
        error: null,
      }),
    );
    expect(loading).toContain('role="status"');
    expect(loading).toContain("Loading board");

    const failed = renderToStaticMarkup(
      createElement(BoardDependencyNotice, {
        isPending: false,
        error: new Error("connection refused"),
      }),
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("connection refused");
  });
});

describe("parseAcceptanceLines", () => {
  it("splits on newlines, trims, and drops blank lines", () => {
    expect(parseAcceptanceLines("  first \n\nsecond\n   \nthird  ")).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("returns an empty array for blank input", () => {
    expect(parseAcceptanceLines("   \n  \n")).toEqual([]);
  });
});
