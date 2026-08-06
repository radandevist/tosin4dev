import { describe, expect, it } from "vitest";
import { draftFromCheck, payloadFromDraft, payloadsFromDrafts } from "./check-draft";
import type { BoardCheck } from "./schemas";

// The editor round-trips every check the schema accepts: draftFromCheck renders
// it for editing, payloadFromDraft hands it back. This property is what makes
// "any check the schema accepts survives an open-and-save untouched" hold — and
// it is exactly what a join/split encoding on newlines violates.
describe("check-draft round-trip", () => {
  it("preserves an argument containing a newline", () => {
    const check: BoardCheck = {
      key: "suite",
      label: "suite",
      command: ["sh", "-c", "set -e\nnpm ci\nnpm test"],
      timeoutMs: 10_000,
    };
    const out = payloadFromDraft(draftFromCheck(check));
    expect(out).toEqual(check);
    // Specifically: the third argument is ONE argument containing newlines, not
    // three arguments. Length 3, index 2 intact.
    expect(out.command).toHaveLength(3);
    expect(out.command[2]).toBe("set -e\nnpm ci\nnpm test");
  });

  it("preserves arguments containing spaces, blanks and trailing whitespace", () => {
    const check: BoardCheck = {
      key: "fmt",
      label: "fmt",
      command: ["echo", "a message with spaces", "  ", "x\n"],
      timeoutMs: 10_000,
    };
    const out = payloadFromDraft(draftFromCheck(check));
    expect(out).toEqual(check);
    expect(out.command[1]).toBe("a message with spaces");
    expect(out.command[2]).toBe("  ");
    expect(out.command[3]).toBe("x\n");
  });

  it("survives a second round-trip unchanged", () => {
    const check: BoardCheck = {
      key: "idempotent",
      label: "idempotent",
      command: ["printf", "a\nb"],
      timeoutMs: 10_000,
    };
    const once = payloadFromDraft(draftFromCheck(check));
    const twice = payloadFromDraft(draftFromCheck(once));
    expect(twice).toEqual(check);
  });
});

describe("payloadsFromDrafts", () => {
  it("keeps incomplete rows in the payload instead of dropping them", () => {
    const rows = [
      { key: "lint", label: "lint", command: ["echo", "ok"], timeoutMs: "10000" },
      { key: "", label: "", command: [""], timeoutMs: "120000" },
      { key: "half", label: "half", command: [""], timeoutMs: "120000" },
    ];
    const payloads = payloadsFromDrafts(rows);
    expect(payloads).toHaveLength(3);
    expect(payloads.map((p) => p.key)).toEqual(["lint", "", "half"]);
  });
});
