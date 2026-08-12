import type { z } from "zod";
import { requireSession } from "./auth.server";
import { boundary, type ServerResult } from "./result";

// This module must remain server-only: result.ts is intentionally browser-safe
// because TanStack Query imports its unwrapResult helper in client bundles.
export async function authenticatedBoundary<Schema extends z.ZodTypeAny, O>(
  schema: Schema,
  raw: unknown,
  run: (input: z.output<Schema>) => O | Promise<O>,
): Promise<ServerResult<O>> {
  return boundary(schema, raw, async (input) => {
    await requireSession();
    return run(input);
  });
}
