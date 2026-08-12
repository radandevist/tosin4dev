import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SPEC_BLOCK_CAP,
  captureDraftedSpec,
  readDraftedSpec,
} from "./draftedSpec.server";

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

  describe("captureDraftedSpec", () => {
    it("captures a valid marker block from stdout and writes spec.json", async () => {
      const stdout = [
        "investigation notes",
        "SPEC_JSON_START",
        JSON.stringify({ intent: "add confetti", acceptance: ["fires once"] }),
        "SPEC_JSON_END",
        "## SUMMARY",
        "done",
      ].join("\n");
      expect(await captureDraftedSpec(stdout, runDir)).toEqual({
        intent: "add confetti",
        scope: "",
        nonGoals: "",
        acceptance: ["fires once"],
        links: [],
        risk: "low",
      });
      expect(await readDraftedSpec(runDir)).toEqual({
        intent: "add confetti",
        scope: "",
        nonGoals: "",
        acceptance: ["fires once"],
        links: [],
        risk: "low",
      });
    });

    it("takes the last block so early scratch output never wins", async () => {
      const stdout = [
        "SPEC_JSON_START",
        JSON.stringify({ intent: "scratch", acceptance: ["wrong"] }),
        "SPEC_JSON_END",
        "more investigation",
        "SPEC_JSON_START",
        JSON.stringify({ intent: "final draft", acceptance: ["fires once"] }),
        "SPEC_JSON_END",
      ].join("\n");
      const draft = await captureDraftedSpec(stdout, runDir);
      expect(draft?.intent).toBe("final draft");
      expect((await readDraftedSpec(runDir))?.intent).toBe("final draft");
    });

    it("writes nothing when the block exceeds the bound", async () => {
      const huge = JSON.stringify({
        intent: "big",
        acceptance: ["x".repeat(SPEC_BLOCK_CAP + 1)],
      });
      const stdout = `SPEC_JSON_START\n${huge}\nSPEC_JSON_END`;
      expect(await captureDraftedSpec(stdout, runDir)).toBeNull();
      expect(await readDraftedSpec(runDir)).toBeNull();
    });

    it("writes nothing when stdout has no marker block", async () => {
      expect(await captureDraftedSpec("no block here", runDir)).toBeNull();
      expect(await readDraftedSpec(runDir)).toBeNull();
    });

    it("requires markers to occupy their own lines", async () => {
      const stdout = [
        "notes mention SPEC_JSON_START but do not delimit a block",
        '{"intent":"not captured"} SPEC_JSON_END',
      ].join("\n");
      expect(await captureDraftedSpec(stdout, runDir)).toBeNull();
      expect(await readDraftedSpec(runDir)).toBeNull();
    });

    it("writes nothing when the block smuggles an approval field", async () => {
      const stdout = [
        "SPEC_JSON_START",
        JSON.stringify({ intent: "do it", approvedBy: "radan" }),
        "SPEC_JSON_END",
      ].join("\n");
      expect(await captureDraftedSpec(stdout, runDir)).toBeNull();
      expect(await readDraftedSpec(runDir)).toBeNull();
    });
  });
});
