import { ObjectId, type WithId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSessionSchema } from "../domain/schemas";
import type { ChatSessionDoc } from "./chat.server";

const mockState = vi.hoisted(() => ({ updateOne: vi.fn() }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    db: async () => ({
      collection: () => ({ updateOne: mockState.updateOne }),
    }),
  };
});

const { reconcileChatSession, STUCK_TURN_MS } = await import("./chat.server");

function session(overrides: Partial<ChatSessionDoc>): WithId<ChatSessionDoc> {
  const at = new Date().toISOString();
  return {
    _id: new ObjectId(),
    ...ChatSessionSchema.parse({ boardId: new ObjectId().toString() }),
    createdAt: at,
    updatedAt: at,
    pid: null,
    logFile: null,
    pendingKind: null,
    pendingUserMessageAt: null,
    ...overrides,
  };
}

describe("reconcileChatSession", () => {
  beforeEach(() => {
    mockState.updateOne.mockReset();
  });

  it("does not reap a fresh pending turn whose recorded pid is dead", async () => {
    await reconcileChatSession(
      session({
        turnStatus: "pending",
        pid: 2147483646,
        pendingUserMessageAt: new Date().toISOString(),
      }),
    );

    expect(mockState.updateOne).not.toHaveBeenCalled();
  });

  it("does not reap a fresh pending turn without a recorded pid", async () => {
    await reconcileChatSession(
      session({
        turnStatus: "pending",
        pid: null,
        pendingUserMessageAt: new Date().toISOString(),
      }),
    );

    expect(mockState.updateOne).not.toHaveBeenCalled();
  });

  it("CAS-reaps a stale pending turn", async () => {
    const doc = session({
      turnStatus: "pending",
      pendingUserMessageAt: new Date(
        Date.now() - STUCK_TURN_MS - 60_000,
      ).toISOString(),
    });

    await reconcileChatSession(doc);

    expect(mockState.updateOne).toHaveBeenCalledOnce();
    expect(mockState.updateOne).toHaveBeenCalledWith(
      { _id: new ObjectId(doc._id.toString()), turnStatus: "pending" },
      expect.objectContaining({
        $set: expect.objectContaining({ turnStatus: "error" }),
      }),
    );
  });

  it("returns without reaping a non-pending turn", async () => {
    await reconcileChatSession(session({ turnStatus: "idle" }));

    expect(mockState.updateOne).not.toHaveBeenCalled();
  });
});
