import { afterEach, describe, expect, it, vi } from "vitest";
import { SpecBundleDTOSchema } from "./specBundles";

const seeded = {
  _id: { toString: () => "507f1f77bcf86cd799439013" },
  sessionId: "507f1f77bcf86cd799439011",
  boardId: "507f1f77bcf86cd799439012",
  status: "drafting",
  rationale: "split",
  members: [{ localKey: "t1", title: "A", type: "implement", runner: "claude",
    spec: { intent: "x", scope: "", nonGoals: "", acceptance: [], links: [], risk: "low" }, dependsOn: [] }],
  lockedTicketIds: null,
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
  lockedAt: null,
};

vi.mock("./db", () => ({
  ObjectId: class { constructor(public v: string) {} toString() { return this.v; } },
  db: () => Promise.resolve({ collection: () => ({ findOne: () => Promise.resolve(seeded) }) }),
}));

afterEach(() => vi.clearAllMocks());

describe("bundle DTO", () => {
  it("returns a strict DTO with no server-only field leak", async () => {
    const { getBundleCore } = await import("./specBundles.server");
    const dto = await getBundleCore({ bundleId: "507f1f77bcf86cd799439013" });
    expect(SpecBundleDTOSchema.parse(dto)).toEqual(dto);
    expect(dto).not.toHaveProperty("lockedAt");
    expect(dto.members[0].localKey).toBe("t1");
  });
});
