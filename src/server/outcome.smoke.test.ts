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

  it("keeps needs_input when the handoff is malformed", async () => {
    await writeFile(
      join(dir, "outcome.json"),
      JSON.stringify({
        outcome: "needs_input",
        question: "Q?",
        handoff: "not an object",
      }),
    );

    const outcome = await readOutcome(dir);

    expect(outcome.outcome).toBe("needs_input");
    expect(outcome.handoff).toBeNull();
  });

  it("round-trips a valid needs_input handoff with defaults", async () => {
    await writeFile(
      join(dir, "outcome.json"),
      JSON.stringify({
        outcome: "needs_input",
        question: "Q?",
        handoff: {
          workDone: "wired the parser",
          filesTouched: ["a.ts"],
          decision: "which base branch",
        },
      }),
    );

    const outcome = await readOutcome(dir);

    expect(outcome.handoff?.workDone).toBe("wired the parser");
    expect(outcome.handoff?.filesTouched).toEqual(["a.ts"]);
    expect(outcome.handoff?.decision).toBe("which base branch");
    expect(outcome.handoff?.commandsRun).toEqual([]);
    expect(outcome.handoff?.options).toEqual([]);
    expect(outcome.handoff?.risk).toBe("");
  });

  it.each(["completed", "failed"] as const)(
    "discards a valid handoff from a %s outcome",
    async (result) => {
      await writeFile(
        join(dir, "outcome.json"),
        JSON.stringify({ outcome: result, handoff: { workDone: "x" } }),
      );

      expect((await readOutcome(dir)).handoff).toBeNull();
    },
  );

  it("keeps failed when its handoff is malformed", async () => {
    await writeFile(
      join(dir, "outcome.json"),
      JSON.stringify({ outcome: "failed", handoff: "garbage" }),
    );

    expect(await readOutcome(dir)).toMatchObject({
      outcome: "failed",
      handoff: null,
    });
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
