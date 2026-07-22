import type { Db } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DB = `tosin4dev-test-bundle-edit-${process.pid}-${Date.now()}`;
const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;

const { db, closeDb, ObjectId } = await import("./db");
const {
  dropBundleMemberCore,
  getBundleCore,
  reorderBundleCore,
  updateBundleMemberCore,
} = await import("./specBundles.server");

let database: Db;

const spec = (intent: string) => ({
  intent,
  scope: "",
  nonGoals: "",
  acceptance: [],
  links: [],
  risk: "low" as const,
});

async function insertBundle(status: "drafting" | "locked"): Promise<string> {
  const at = new Date().toISOString();
  const result = await database.collection("specBundles").insertOne({
    sessionId: new ObjectId().toString(),
    boardId: new ObjectId().toString(),
    status,
    rationale: "Split the work",
    members: [
      {
        localKey: "t1",
        title: "First ticket",
        type: "implement",
        runner: "claude",
        spec: spec("Implement the first ticket"),
        dependsOn: [],
      },
      {
        localKey: "t2",
        title: "Second ticket",
        type: "review",
        runner: "codex",
        spec: spec("Review the first ticket"),
        dependsOn: ["t1"],
      },
    ],
    lockedTicketIds:
      status === "locked"
        ? [new ObjectId().toString(), new ObjectId().toString()]
        : null,
    createdAt: at,
    updatedAt: at,
    lockedAt: status === "locked" ? at : null,
  });
  return result.insertedId.toString();
}

beforeAll(async () => {
  database = await db();
});

beforeEach(async () => {
  await database.collection("specBundles").deleteMany({});
});

afterAll(async () => {
  await database?.dropDatabase();
  await closeDb();
  process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;
});

describe("bundle edit cores", () => {
  it("updates, reorders, and drops drafting members without persisting an invalid graph", async () => {
    const bundleId = await insertBundle("drafting");

    await updateBundleMemberCore({
      bundleId,
      localKey: "t1",
      patch: { title: "Updated first ticket" },
    });
    expect((await getBundleCore({ bundleId })).members[0].title).toBe(
      "Updated first ticket",
    );

    await reorderBundleCore({ bundleId, orderedLocalKeys: ["t2", "t1"] });
    expect(
      (await getBundleCore({ bundleId })).members.map((member) => member.localKey),
    ).toEqual(["t2", "t1"]);

    await expect(
      reorderBundleCore({ bundleId, orderedLocalKeys: ["t1", "tX"] }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      (await getBundleCore({ bundleId })).members.map((member) => member.localKey),
    ).toEqual(["t2", "t1"]);

    await expect(
      updateBundleMemberCore({
        bundleId,
        localKey: "t1",
        patch: { dependsOn: ["t2"] },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      (await getBundleCore({ bundleId })).members.find(
        (member) => member.localKey === "t1",
      )?.dependsOn,
    ).toEqual([]);

    await dropBundleMemberCore({ bundleId, localKey: "t1" });
    const afterDrop = await getBundleCore({ bundleId });
    expect(afterDrop.members.map((member) => member.localKey)).toEqual(["t2"]);
    expect(afterDrop.members[0].dependsOn).toEqual([]);

    await expect(
      dropBundleMemberCore({ bundleId, localKey: "t2" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await getBundleCore({ bundleId })).members).toHaveLength(1);
  });

  it("rejects update, drop, and reorder for a locked bundle", async () => {
    const bundleId = await insertBundle("locked");

    await expect(
      updateBundleMemberCore({
        bundleId,
        localKey: "t1",
        patch: { title: "Cannot change" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      dropBundleMemberCore({ bundleId, localKey: "t1" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      reorderBundleCore({ bundleId, orderedLocalKeys: ["t2", "t1"] }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
