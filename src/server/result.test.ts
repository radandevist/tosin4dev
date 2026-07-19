import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { boundary, ServerResultError, unwrapResult } from "./result";

const Input = z.object({ n: z.number() }).strict();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("boundary (server boundary helper)", () => {
  it("returns the ok union with the core result on valid input", async () => {
    const r = await boundary(Input, { n: 2 }, (input) =>
      Promise.resolve(input.n * 10),
    );
    expect(r).toEqual({ ok: true, data: 20 });
  });

  it("returns the error union on invalid input instead of throwing", async () => {
    const r = await boundary(Input, { n: "nope" }, () =>
      Promise.resolve("unreachable"),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("invalid_input");
      expect(typeof r.error.message).toBe("string");
    }
  });

  it("rejects unknown keys via the strict schema boundary", async () => {
    const r = await boundary(Input, { n: 1, extra: true }, () =>
      Promise.resolve(1),
    );
    expect(r.ok).toBe(false);
  });

  it("redacts an unexpected thrown error but logs it server-side", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "connection to mongodb://user:pw@internal:27017 refused";
    const r = await boundary(Input, { n: 1 }, () => {
      throw new Error(secret);
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("internal");
      // The raw driver/internal message must never cross the wire.
      expect(r.error.message).toBe("Unexpected server error");
      expect(r.error.message).not.toContain("mongodb");
    }
    // ...but the operator still gets the real error in the server logs.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0].some((arg) => String(arg).includes(secret))).toBe(
      true,
    );
  });

  it("preserves the code and message of a safe expected error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await boundary(Input, { n: 1 }, () => {
      throw new ServerResultError("not_found", "board not found: acme");
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("not_found");
      expect(r.error.message).toBe("board not found: acme");
    }
    // Expected errors are intentional control flow, not incidents to log.
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("unwrapResult (query boundary helper)", () => {
  it("returns data on an ok result", () => {
    expect(unwrapResult({ ok: true, data: 42 })).toBe(42);
  });

  it("throws an Error carrying the message on an error result", () => {
    expect(() =>
      unwrapResult({ ok: false, error: { code: "internal", message: "boom" } }),
    ).toThrow(/boom/);
  });
});
