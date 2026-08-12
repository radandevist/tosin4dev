import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  getRequestHeader,
  getRequestProtocol,
  setResponseHeader,
} from "@tanstack/react-start/server";
import { z } from "zod";
import { db } from "./db";
import { ServerResultError } from "./result";

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = "tosin4dev_session";

export const AuthSessionSchema = z
  .object({
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function hashSessionToken(token: string): string {
  return hash(token).toString("hex");
}

export async function createSession(token: string): Promise<void> {
  const createdAt = new Date();
  const session = AuthSessionSchema.parse({
    tokenHash: hashSessionToken(token),
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + SESSION_DURATION_MS).toISOString(),
  });
  await (await db()).collection("authSessions").insertOne(session);
}

export async function isSessionValid(token: string): Promise<boolean> {
  const session = await (await db()).collection("authSessions").findOne({
    tokenHash: hashSessionToken(token),
    expiresAt: { $gt: new Date().toISOString() },
  });
  return session !== null;
}

export async function revokeSession(token: string): Promise<void> {
  await (await db()).collection("authSessions").deleteOne({
    tokenHash: hashSessionToken(token),
  });
}

export function sessionCookie(
  token: string,
  { secure }: { secure: boolean },
): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_DURATION_MS / 1000}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function readSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const cookie of cookieHeader.split(";")) {
    const [name, ...value] = cookie.trim().split("=");
    if (name === SESSION_COOKIE_NAME) return value.join("=") || null;
  }
  return null;
}

export async function isRequestAuthorized(
  cookieHeader: string | undefined,
): Promise<boolean> {
  const token = readSessionToken(cookieHeader);
  return token ? isSessionValid(token) : false;
}

export async function issueSession(): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  await createSession(token);
  setResponseHeader(
    "set-cookie",
    sessionCookie(token, { secure: getRequestProtocol() === "https" }),
  );
}

export async function requireSession(): Promise<void> {
  const authorized = await isRequestAuthorized(getRequestHeader("cookie"));
  if (!authorized) {
    throw new ServerResultError("unauthorized", "Unlock Tosin4dev to continue");
  }
}

export async function revokeCurrentSession(): Promise<void> {
  const token = readSessionToken(getRequestHeader("cookie"));
  if (token) await revokeSession(token);
  setResponseHeader(
    "set-cookie",
    sessionCookie("", { secure: getRequestProtocol() === "https" }).replace(
      `Max-Age=${SESSION_DURATION_MS / 1000}`,
      "Max-Age=0",
    ),
  );
}

export async function authenticateSecret(candidate: string): Promise<boolean> {
  const configured = process.env.TOSIN4DEV_AUTH_SECRET?.trim();
  if (!configured) return false;

  return timingSafeEqual(hash(candidate), hash(configured));
}
