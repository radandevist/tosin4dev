import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const privateServerFunctionModules = [
  "boards.ts",
  "browse.ts",
  "chat.ts",
  "runs.ts",
  "specBundles.ts",
  "tickets.ts",
];

describe("server-function authentication inventory", () => {
  it("routes every private server-function handler through the auth boundary", async () => {
    for (const filename of privateServerFunctionModules) {
      const source = await readFile(resolve(import.meta.dirname, filename), "utf8");
      expect(source, filename).toContain("authenticatedBoundary(");
    }
  });
});
