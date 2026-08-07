import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDraftedSpec } from "./draftedSpec.server";

describe("readDraftedSpec", () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "t4d-ds-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("returns null when spec.json is absent", async () => {
    expect(await readDraftedSpec(runDir)).toBeNull();
  });

  it("returns null when spec.json is not valid JSON", async () => {
    await writeFile(join(runDir, "spec.json"), "{not json");
    expect(await readDraftedSpec(runDir)).toBeNull();
  });

  it("returns null when intent is missing", async () => {
    await writeFile(
      join(runDir, "spec.json"),
      JSON.stringify({ acceptance: ["a"] }),
    );
    expect(await readDraftedSpec(runDir)).toBeNull();
  });

  it("returns null when the runner smuggles an approval field", async () => {
    await writeFile(
      join(runDir, "spec.json"),
      JSON.stringify({
        intent: "do it",
        approvedAt: "2026-08-07T00:00:00.000Z",
        approvedBy: "radan",
      }),
    );
    expect(await readDraftedSpec(runDir)).toBeNull();
  });

  it("parses a valid draft and applies defaults", async () => {
    await writeFile(
      join(runDir, "spec.json"),
      JSON.stringify({ intent: "add confetti", acceptance: ["fires once"] }),
    );
    expect(await readDraftedSpec(runDir)).toEqual({
      intent: "add confetti",
      scope: "",
      nonGoals: "",
      acceptance: ["fires once"],
      links: [],
      risk: "low",
    });
  });
});
