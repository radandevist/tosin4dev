import { describe, expect, it } from "vitest";
import {
  assertPublishable,
  draftPrArgs,
  parseCreatedPrUrl,
  parsePrListOutput,
} from "./publish.server";

const BOARD = {
  slug: "publyapp",
  name: "PublyApp",
  repoPath: "/home/radan/Projects/PublyApp/publyapp",
  defaultBaseBranch: "develop",
  checks: [],
};

describe("draftPrArgs", () => {
  it("always creates a draft PR", () => {
    const args = draftPrArgs({
      base: "develop",
      head: "tosin4dev/run/abc",
      title: "#1 confetti",
      bodyFile: "/tmp/body.md",
    });
    expect(args).toEqual([
      "pr", "create",
      "--draft",
      "--base", "develop",
      "--head", "tosin4dev/run/abc",
      "--title", "#1 confetti",
      "--body-file", "/tmp/body.md",
    ]);
  });

  it("never contains a ready-for-review or merge flag", () => {
    const args = draftPrArgs({
      base: "develop", head: "h", title: "t", bodyFile: "/tmp/b",
    });
    expect(args).not.toContain("--fill");
    expect(args.join(" ")).not.toMatch(/ready|merge/);
  });
});

describe("assertPublishable", () => {
  it("refuses to publish the base branch itself", () => {
    expect(() => assertPublishable(BOARD, "develop")).toThrow(/base branch/i);
  });

  it("accepts a namespaced run branch", () => {
    expect(() => assertPublishable(BOARD, "tosin4dev/run/abc")).not.toThrow();
  });

  it("refuses an empty branch", () => {
    expect(() => assertPublishable(BOARD, "")).toThrow();
  });
});

describe("parseCreatedPrUrl", () => {
  it("accepts a plain https url", () => {
    expect(parseCreatedPrUrl("https://github.com/o/r/pull/1\n")).toBe(
      "https://github.com/o/r/pull/1",
    );
  });

  it("rejects a non-http url and names what gh printed", () => {
    let message = "";
    try {
      parseCreatedPrUrl("javascript:alert(1)");
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    expect(message).toMatch(/no usable URL/);
    expect(message).toContain("javascript:alert(1)");
  });

  it("rejects an empty or banner-only stdout", () => {
    expect(() => parseCreatedPrUrl("")).toThrow(/no usable URL/);
    expect(() => parseCreatedPrUrl("Welcome to GitHub! Release 2.99.0\n")).toThrow(
      /no usable URL/,
    );
  });
});

describe("parsePrListOutput", () => {
  it("returns the url of a single match", () => {
    expect(parsePrListOutput('[{"url":"https://github.com/o/r/pull/1"}]')).toBe(
      "https://github.com/o/r/pull/1",
    );
  });

  it("treats an empty listing as no existing PR", () => {
    expect(parsePrListOutput("[]")).toBeNull();
  });

  it("treats a non-json prefix as no existing PR so the create still runs", () => {
    // The branch is already pushed by this point; a malformed listing must not
    // block publishing, only fail to find a reuse candidate.
    expect(parsePrListOutput("WARNING: gh update available\n[]")).toBeNull();
  });

  it("treats a non-url payload as no existing PR", () => {
    expect(parsePrListOutput('[{"url":"javascript:alert(1)"}]')).toBeNull();
  });
});
