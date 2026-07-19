import { describe, it, expect } from "vitest";
import { transition, HUMAN_GATES, EventSchema } from "./stateMachine";
import { TicketStatus } from "./schemas";

describe("transition", () => {
  it("walks the happy path", () => {
    expect(transition("inbox", "submit_spec")).toBe("spec_review");
    expect(transition("spec_review", "approve_spec")).toBe("approved");
    expect(transition("approved", "dispatch")).toBe("running");
    expect(transition("running", "run_succeeded")).toBe("review_ready");
    expect(transition("review_ready", "approve_final")).toBe("done");
  });

  it("exposes exactly two human gates", () => {
    expect(HUMAN_GATES).toEqual(["spec_review", "review_ready"]);
  });
});

describe("EventSchema", () => {
  it("accepts every known event, including archive", () => {
    for (const event of EventSchema.options) {
      expect(EventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("rejects an unknown event at runtime", () => {
    expect(EventSchema.safeParse("frobnicate").success).toBe(false);
    expect(() => EventSchema.parse("frobnicate")).toThrow();
  });
});

describe("transition matrix", () => {
  // The complete set of non-archive edges, spelled out here — independently of
  // the machine's internal table — so the matrix below is a genuine oracle
  // rather than a mirror of the implementation. `archive` is excluded on
  // purpose: it is unconditional and asserted separately in the loop.
  const EDGES: Record<string, string> = {
    "inbox:submit_spec": "spec_review",
    "spec_review:approve_spec": "approved",
    "spec_review:request_spec_changes": "inbox",
    "approved:dispatch": "running",
    "running:run_succeeded": "review_ready",
    "running:run_failed": "blocked",
    "blocked:resume": "approved",
    "review_ready:approve_final": "done",
    "review_ready:request_changes": "running",
  };

  it("proves every defined edge, every invalid pair, and unconditional archive", () => {
    for (const from of TicketStatus.options) {
      for (const event of EventSchema.options) {
        if (event === "archive") {
          // Unconditional: archive is reachable from every state.
          expect(transition(from, event)).toBe("archived");
          continue;
        }

        const key = `${from}:${event}` as const;
        if (key in EDGES) {
          // A defined edge resolves to exactly its target status.
          expect(transition(from, event)).toBe(EDGES[key]);
        } else {
          // Any pair not in the edge set is an invalid transition.
          expect(() => transition(from, event)).toThrow(/invalid/i);
        }
      }
    }
  });

  it("covers every edge in EDGES (no dead entries)", () => {
    const statuses = new Set<string>(TicketStatus.options);
    const events = new Set<string>(EventSchema.options);
    for (const key of Object.keys(EDGES)) {
      const [from, event] = key.split(":");
      expect(statuses.has(from)).toBe(true);
      expect(events.has(event)).toBe(true);
      expect(transition(from as never, event as never)).toBe(EDGES[key]);
    }
  });
});
