import { describe, expect, it } from "vitest";
import { parseBundle, validateBundleMembers } from "./chatResult";

const m = (localKey: string, dependsOn: string[] = []) => ({
  localKey, title: "T", type: "implement", runner: "claude",
  spec: { intent: "x", scope: "", nonGoals: "", acceptance: [], links: [], risk: "low" }, dependsOn,
});

describe("validateBundleMembers", () => {
  it("accepts a valid DAG", () => {
    expect(validateBundleMembers([m("t1"), m("t2", ["t1"])])).toBeNull();
  });
  it("rejects empty, dup keys, self-dep, dangling ref, and cycles", () => {
    expect(validateBundleMembers([])).not.toBeNull();
    expect(validateBundleMembers([m("t1"), m("t1")])).not.toBeNull();
    expect(validateBundleMembers([m("t1", ["t1"])])).not.toBeNull();
    expect(validateBundleMembers([m("t1", ["tX"])])).not.toBeNull();
    expect(validateBundleMembers([m("t1", ["t2"]), m("t2", ["t1"])])).not.toBeNull();
  });
});

describe("parseBundle", () => {
  const valid = JSON.stringify({ rationale: "r", members: [m("t1"), m("t2", ["t1"])] });
  it("parses valid + fenced json", () => {
    expect(parseBundle(valid)?.members).toHaveLength(2);
    expect(parseBundle("```json\n" + valid + "\n```")?.members).toHaveLength(2);
  });
  it("returns null on prose or schema-invalid", () => {
    expect(parseBundle("here you go!")).toBeNull();
    expect(parseBundle(`{"rationale":"r"}`)).toBeNull();
  });
});
