import { describe, it, expect } from "vitest";
import { gatesForStatus } from "./GateButtons";
import { parseAcceptanceLines } from "../routes/b/$boardSlug/new";
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
