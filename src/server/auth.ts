import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authenticatedBoundary } from "./authBoundary.server";
import { loginCore, revokeCurrentSession } from "./auth.server";
import { boundary, type ServerResult } from "./result";

const LoginInputSchema = z.object({ secret: z.string().min(1) }).strict();
const EmptyInputSchema = z.object({}).strict();
const passthrough = (data: unknown): unknown => data;

export const login = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ unlocked: true }>> =>
    boundary(LoginInputSchema, data, loginCore),
  );

export const logout = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(({ data }): Promise<ServerResult<{ unlocked: false }>> =>
    authenticatedBoundary(EmptyInputSchema, data, async () => {
      await revokeCurrentSession();
      return { unlocked: false };
    }),
  );

export const sessionStatus = createServerFn({ method: "GET" }).handler(
  (): Promise<ServerResult<{ unlocked: true }>> =>
    authenticatedBoundary(EmptyInputSchema, {}, () => ({ unlocked: true })),
);
