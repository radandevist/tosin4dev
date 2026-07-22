import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { ChatSessionSchema } from "../domain/schemas";
import { ChatSessionDTOSchema } from "./chat";

const mockState = vi.hoisted(() => ({ doc: null as unknown }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    db: async () => ({
      collection: () => ({
        findOne: async () => mockState.doc,
      }),
    }),
  };
});

const { getChatSessionCore } = await import("./chat.server");

describe("chat DTO mapping", () => {
  it("maps a session without leaking server bookkeeping", async () => {
    const id = new ObjectId();
    const session = ChatSessionSchema.parse({
      boardId: new ObjectId().toString(),
    });
    mockState.doc = {
      _id: id,
      ...session,
      createdAt: "2026-07-22T10:00:00.000Z",
      updatedAt: "2026-07-22T10:00:00.000Z",
      pid: 4242,
      logFile: "/repo/.tosin4dev/chat/x/turn.log",
      pendingKind: null,
      pendingUserMessageAt: null,
    };

    const dto = await getChatSessionCore({ sessionId: id.toString() });

    expect(ChatSessionDTOSchema.parse(dto)).toEqual(dto);
    expect(dto).not.toHaveProperty("pid");
    expect(dto).not.toHaveProperty("logFile");
    expect(dto).not.toHaveProperty("pendingKind");
    expect(dto.bundleId).toBeNull();
    expect(dto).not.toHaveProperty("proposedSpec");
    expect(dto).not.toHaveProperty("ticketId");
  });
});
