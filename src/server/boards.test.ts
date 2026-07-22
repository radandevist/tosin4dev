import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Point the lazy db() singleton at a throwaway database *before* anything
// triggers a connection. Unique per run so parallel suites never collide.
const TEST_DB = `tosin4dev-test-boards-${process.pid}-${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;

const { db, closeDb } = await import("./db");
const { createBoardCore, getBoardCore, listBoardsCore } = await import(
  "./boards.server"
);

const BOARD = {
  slug: "publyapp",
  name: "PublyApp",
  repoPath: "/home/radan/Projects/PublyApp",
  defaultBaseBranch: "develop",
  checks: [],
};

describe("boards server functions", () => {
  beforeAll(async () => {
    await (await db()).collection("boards").deleteMany({});
  });

  afterAll(async () => {
    await (await db()).dropDatabase();
    await closeDb();
  });

  it("creates a board with server-owned timestamps and returns a string id", async () => {
    const { id } = await createBoardCore(BOARD);
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^[0-9a-fA-F]{24}$/);

    const dto = await getBoardCore("publyapp");
    // Browser-safe DTO: _id is a plain string, never a raw ObjectId.
    expect(typeof dto._id).toBe("string");
    expect(dto._id).toBe(id);
    expect(dto.slug).toBe("publyapp");
    // Server initialises the audit timestamps.
    expect(typeof dto.createdAt).toBe("string");
    expect(typeof dto.updatedAt).toBe("string");
  });

  it("rejects a duplicate slug via the unique index", async () => {
    await createBoardCore({ ...BOARD, slug: "dupe", name: "First" });
    await expect(
      createBoardCore({ ...BOARD, slug: "dupe", name: "Second" }),
    ).rejects.toThrow();
  });

  it("lists boards sorted by name", async () => {
    await (await db()).collection("boards").deleteMany({});
    await createBoardCore({ ...BOARD, slug: "zulu", name: "Zulu" });
    await createBoardCore({ ...BOARD, slug: "alpha", name: "Alpha" });
    const names = (await listBoardsCore()).map((b) => b.name);
    expect(names).toEqual(["Alpha", "Zulu"]);
  });

  it("throws a useful not-found error for an unknown slug", async () => {
    await expect(getBoardCore("does-not-exist")).rejects.toThrow(/not found/i);
  });
});
