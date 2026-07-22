import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOutcome } from "./outcome.server";

describe("readOutcome", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "t4d-oc-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses a needs_input outcome file", async () => {
    await writeFile(
      join(dir, "outcome.json"),
      JSON.stringify({ outcome: "needs_input", question: "Q?" }),
    );

    const outcome = await readOutcome(dir);

    expect(outcome.outcome).toBe("needs_input");
    expect(outcome.question).toBe("Q?");
  });

  it("fails closed when the file is missing", async () => {
    expect((await readOutcome(dir)).outcome).toBe("failed");
  });

  it("fails closed when the file is unreadable", async () => {
    await mkdir(join(dir, "outcome.json"));

    expect((await readOutcome(dir)).outcome).toBe("failed");
  });

  it("fails closed when the file contains invalid JSON", async () => {
    await writeFile(join(dir, "outcome.json"), "not json");

    expect((await readOutcome(dir)).outcome).toBe("failed");
  });

  it("fails closed when the file has a schema-invalid body", async () => {
    await writeFile(
      join(dir, "outcome.json"),
      JSON.stringify({ outcome: "maybe" }),
    );

    expect((await readOutcome(dir)).outcome).toBe("failed");
  });
});
