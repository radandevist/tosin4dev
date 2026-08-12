import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { listDirectoriesCore, type DirListing } from "./browse.server";
import { authenticatedBoundary } from "./authBoundary.server";
import type { ServerResult } from "./result";

// Browser-safe wire contract. A listing is plain {path,parent,entries} — no
// Node types cross the RPC boundary.
export type { DirEntry, DirListing } from "./browse.server";

// The input path is deliberately NOT AbsolutePathString: a relative path is
// resolved against the browse root rather than rejected, so the picker can send
// back exactly what a row navigation produced.
const BrowseInputSchema = z.object({ path: z.string().optional() }).strict();

const passthrough = (data: unknown): unknown => data;

export const listDirectories = createServerFn({ method: "GET" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<DirListing>> =>
    authenticatedBoundary(BrowseInputSchema, data, listDirectoriesCore),
  );
