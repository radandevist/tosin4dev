import { describe, expect, it } from "vitest";
import { unmetDependencies } from "./dependencies";

describe("unmetDependencies", () => {
  it.each([
    {
      name: "has no dependencies",
      deps: [],
      present: [],
      expected: [],
    },
    {
      name: "has only done dependencies",
      deps: ["a", "b"],
      present: [
        { ticketId: "a", seq: 1, status: "done" as const },
        { ticketId: "b", seq: 2, status: "done" as const },
      ],
      expected: [],
    },
    {
      name: "has a running dependency",
      deps: ["a"],
      present: [{ ticketId: "a", seq: 1, status: "running" as const }],
      expected: [
        { ticketId: "a", seq: 1, status: "running", reason: "pending" },
      ],
    },
    {
      name: "has an approved dependency",
      deps: ["a"],
      present: [{ ticketId: "a", seq: 1, status: "approved" as const }],
      expected: [
        { ticketId: "a", seq: 1, status: "approved", reason: "pending" },
      ],
    },
    {
      name: "has an archived dependency",
      deps: ["a"],
      present: [{ ticketId: "a", seq: 1, status: "archived" as const }],
      expected: [
        { ticketId: "a", seq: 1, status: "archived", reason: "archived" },
      ],
    },
    {
      name: "has a missing dependency",
      deps: ["a"],
      present: [],
      expected: [
        { ticketId: "a", seq: null, status: null, reason: "missing" },
      ],
    },
    {
      name: "preserves dependency order for mixed results",
      deps: ["missing", "done", "archived", "pending"],
      present: [
        { ticketId: "pending", seq: 4, status: "review_ready" as const },
        { ticketId: "done", seq: 2, status: "done" as const },
        { ticketId: "archived", seq: 3, status: "archived" as const },
      ],
      expected: [
        { ticketId: "missing", seq: null, status: null, reason: "missing" },
        { ticketId: "archived", seq: 3, status: "archived", reason: "archived" },
        { ticketId: "pending", seq: 4, status: "review_ready", reason: "pending" },
      ],
    },
  ])("classifies when it $name", ({ deps, present, expected }) => {
    expect(unmetDependencies(deps, present)).toEqual(expected);
  });
});
