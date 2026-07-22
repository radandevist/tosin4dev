import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { DependencyStatusDTOSchema } from "./tickets";

const mockState = vi.hoisted(() => ({
  ticket: null as null | { dependsOn: string[] },
  dependencies: [] as unknown[],
}));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    db: async () => ({
      collection: () => ({
        findOne: async () => mockState.ticket,
        find: () => ({
          project: () => ({ toArray: async () => mockState.dependencies }),
        }),
      }),
    }),
  };
});

const { dependencyStatusCore } = await import("./tickets.server");

describe("dependency status DTO", () => {
  it("returns unmet dependency details without leaking server fields", async () => {
    const ticketId = new ObjectId().toString();
    const pendingId = new ObjectId().toString();
    const archivedId = new ObjectId().toString();
    const missingId = new ObjectId().toString();
    mockState.ticket = { dependsOn: [pendingId, archivedId, missingId] };
    mockState.dependencies = [
      {
        _id: new ObjectId(pendingId),
        seq: 2,
        title: "Build the API",
        status: "running",
        serverSecret: "do not leak",
      },
      {
        _id: new ObjectId(archivedId),
        seq: 3,
        title: "Old migration",
        status: "archived",
        serverSecret: "do not leak",
      },
    ];

    const dto = await dependencyStatusCore({ ticketId });

    expect(dto).toEqual({
      blocked: true,
      unmet: [
        {
          ticketId: pendingId,
          seq: 2,
          title: "Build the API",
          status: "running",
          reason: "pending",
        },
        {
          ticketId: archivedId,
          seq: 3,
          title: "Old migration",
          status: "archived",
          reason: "archived",
        },
        {
          ticketId: missingId,
          seq: null,
          title: null,
          status: null,
          reason: "missing",
        },
      ],
    });
    expect(DependencyStatusDTOSchema.parse(dto)).toEqual(dto);
    expect(dto.unmet[0]).not.toHaveProperty("serverSecret");
    expect(
      DependencyStatusDTOSchema.safeParse({ ...dto, serverSecret: true }).success,
    ).toBe(false);
  });

  it("returns not blocked without querying dependencies when none are declared", async () => {
    mockState.ticket = { dependsOn: [] };
    mockState.dependencies = [{ serverSecret: "must remain unread" }];

    await expect(
      dependencyStatusCore({ ticketId: new ObjectId().toString() }),
    ).resolves.toEqual({ blocked: false, unmet: [] });
  });
});
