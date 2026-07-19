import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boundary, unwrapResult } from "./result";

const Input = z.object({ n: z.number() }).strict();

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

  it("catches a thrown core error and returns the error union", async () => {
    const r = await boundary(Input, { n: 1 }, () => {
      throw new Error("core blew up");
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("internal");
      expect(r.error.message).toBe("core blew up");
    }
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
