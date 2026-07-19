import type { z } from "zod";

// The single wire contract for every board/ticket server function. A call
// either succeeds with typed `data`, or fails with a typed `error` — it never
// resolves to a bare value and never lets an exception escape to the client as
// an opaque 500. `code` is a short machine tag; `message` is human-readable.
export type ServerResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

// The one sanctioned way for core logic to fail with a message that is safe to
// show the client. Anything a core function throws that is NOT a
// ServerResultError is treated as an unexpected incident: it is logged
// server-side and collapsed to an opaque `internal` error, so raw
// Mongo/driver/stack messages never cross the wire. Expected, user-facing
// failures (not-found, stale transition, …) throw this instead; `code` is a
// short machine tag and `message` is vetted human-readable text.
export class ServerResultError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ServerResultError";
    this.code = code;
  }
}

// The server-side boundary. Every createServerFn handler validates with
// `.validator(z.unknown())` and then delegates here so that validation failures
// return the union rather than throwing out of the handler before it runs. The
// explicit typed schema is kept at the call site (retaining typed variables);
// `run` is the core function, which may still throw and is integration-tested
// directly — any throw is caught and mapped into the error union.
export async function boundary<I, O>(
  schema: z.ZodType<I>,
  raw: unknown,
  run: (input: I) => O | Promise<O>,
): Promise<ServerResult<O>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "invalid_input", message: parsed.error.message },
    };
  }
  try {
    return { ok: true, data: await run(parsed.data) };
  } catch (err) {
    // A ServerResultError is an expected, vetted failure: pass its code and
    // message straight through to the client.
    if (err instanceof ServerResultError) {
      return { ok: false, error: { code: err.code, message: err.message } };
    }
    // Anything else is unexpected. Log the real error server-side for
    // diagnosis, but return a fixed opaque message so no Mongo/driver/internal
    // detail ever reaches the browser.
    console.error("Unexpected server error in boundary:", err);
    return {
      ok: false,
      error: { code: "internal", message: "Unexpected server error" },
    };
  }
}

// The query-side boundary. TanStack Query models failure as a thrown error, so
// fetchers/mutations pipe every ServerResult through this: it returns `data` on
// success and throws a plain Error carrying the message on failure. No `any`,
// no `as never`, no error-framework — just the union collapsed to T-or-throw.
export function unwrapResult<T>(result: ServerResult<T>): T {
  if (result.ok) return result.data;
  throw new Error(result.error.message);
}
