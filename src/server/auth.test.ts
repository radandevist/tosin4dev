import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  protocol: "http",
  setResponseHeader: vi.fn(),
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeader: () => runtime.cookie,
  getRequestProtocol: () => runtime.protocol,
  setResponseHeader: runtime.setResponseHeader,
}));

import {
  authenticateSecret,
  createSession,
  hashSessionToken,
  issueSession,
  isSessionValid,
  isRequestAuthorized,
  loginCore,
  readSessionToken,
  requireSession,
  revokeSession,
  sessionCookie,
} from "./auth.server";
import { closeDb, db } from "./db";

const originalSecret = process.env.TOSIN4DEV_AUTH_SECRET;
const originalMongoUri = process.env.MONGODB_URI;
const testDb = `tosin4dev-test-auth-${process.pid}-${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${testDb}`;

afterEach(() => {
  process.env.TOSIN4DEV_AUTH_SECRET = originalSecret;
  runtime.cookie = undefined;
  runtime.protocol = "http";
  runtime.setResponseHeader.mockReset();
});

afterAll(async () => {
  await (await db()).dropDatabase();
  await closeDb();
  process.env.MONGODB_URI = originalMongoUri;
});

describe("local auth secret", () => {
  it("rejects a missing configured secret", async () => {
    delete process.env.TOSIN4DEV_AUTH_SECRET;

    await expect(authenticateSecret("candidate")).resolves.toBe(false);
  });

  it("rejects a whitespace-only configured secret", async () => {
    process.env.TOSIN4DEV_AUTH_SECRET = "   ";

    await expect(authenticateSecret("candidate")).resolves.toBe(false);
  });

  it("accepts only the configured secret", async () => {
    process.env.TOSIN4DEV_AUTH_SECRET = "correct horse battery staple";

    await expect(
      authenticateSecret("correct horse battery staple"),
    ).resolves.toBe(true);
    await expect(authenticateSecret("wrong secret")).resolves.toBe(false);
  });

  it("hashes session tokens as stable SHA-256 hex", () => {
    expect(hashSessionToken("opaque-token")).toBe(
      "84d3f23da9b5f51b3269566eff05d3fb23607eeef89567f9cd280b90ca0dbc5c",
    );
  });

  it("stores only a hash for a newly issued session", async () => {
    await createSession("raw-opaque-token");

    const stored = await (await db()).collection("authSessions").findOne({});
    expect(stored).toMatchObject({
      tokenHash: hashSessionToken("raw-opaque-token"),
    });
    expect(JSON.stringify(stored)).not.toContain("raw-opaque-token");
  });

  it("does not allow duplicate session-token hashes", async () => {
    await createSession("duplicate-session-token");

    await expect(createSession("duplicate-session-token")).rejects.toThrow();
  });

  it("accepts an unexpired session token", async () => {
    await createSession("valid-session-token");

    await expect(isSessionValid("valid-session-token")).resolves.toBe(true);
    await expect(isSessionValid("unknown-session-token")).resolves.toBe(false);
  });

  it("rejects an expired session token", async () => {
    await (await db()).collection("authSessions").insertOne({
      tokenHash: hashSessionToken("expired-session-token"),
      createdAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-01T12:00:00.000Z",
    });

    await expect(isSessionValid("expired-session-token")).resolves.toBe(false);
  });

  it("revokes the current opaque token", async () => {
    await createSession("revocable-session-token");

    await revokeSession("revocable-session-token");

    await expect(isSessionValid("revocable-session-token")).resolves.toBe(
      false,
    );
  });

  it("serializes a strictly scoped session cookie", () => {
    expect(sessionCookie("token-value", { secure: false })).toBe(
      "tosin4dev_session=token-value; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200",
    );
    expect(sessionCookie("token-value", { secure: true })).toContain(
      "; Secure",
    );
  });

  it("reads the cookie value without splitting its encoded payload", () => {
    expect(
      readSessionToken(
        "theme=dark; tosin4dev_session=opaque=payload; analytics=enabled",
      ),
    ).toBe("opaque=payload");
  });

  it("authorizes only a request carrying a valid session cookie", async () => {
    await createSession("request-session-token");

    await expect(isRequestAuthorized(undefined)).resolves.toBe(false);
    await expect(
      isRequestAuthorized("tosin4dev_session=request-session-token"),
    ).resolves.toBe(true);
  });

  it("issues a raw token only in an HTTP-only response cookie", async () => {
    await issueSession();

    expect(runtime.setResponseHeader).toHaveBeenCalledOnce();
    const [, cookie] = runtime.setResponseHeader.mock.calls[0];
    expect(cookie).toContain("HttpOnly");
    const token = /^tosin4dev_session=([^;]+)/.exec(cookie)?.[1];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await (await db()).collection("authSessions").findOne({
      tokenHash: hashSessionToken(token ?? ""),
    });
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(token ?? "");
  });

  it("unlocks only when the submitted secret is valid", async () => {
    process.env.TOSIN4DEV_AUTH_SECRET = "correct horse battery staple";

    await expect(loginCore({ secret: "wrong secret" })).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(
      loginCore({ secret: "correct horse battery staple" }),
    ).resolves.toEqual({ unlocked: true });
  });

  it("fails closed when the configured secret is removed", async () => {
    process.env.TOSIN4DEV_AUTH_SECRET = "correct horse battery staple";
    await createSession("configured-then-removed-token");
    runtime.cookie = "tosin4dev_session=configured-then-removed-token";
    delete process.env.TOSIN4DEV_AUTH_SECRET;

    await expect(requireSession()).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});
