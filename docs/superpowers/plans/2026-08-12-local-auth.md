# Local Shared-Secret Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a revocable local session before any Tosin4dev server function can read or mutate private board, ticket, run, chat, filesystem, or agent state.

**Architecture:** Add an opaque Mongo-backed session service and a single authenticated transport boundary that extends the existing typed `boundary` contract. Login/logout remain the only narrowly unauthenticated server functions; every existing business server function changes mechanically from `boundary` to `authenticatedBoundary`. A small root-level lock screen is a UX gate only; the server boundary remains authoritative.

**Tech Stack:** TypeScript, Bun, Vitest, MongoDB driver, Zod, Node `crypto`, TanStack Start server functions and response-header primitives.

---

## Global constraints

- Source of truth: `docs/superpowers/specs/2026-08-12-local-auth-design.md`.
- Read `TOSIN4DEV_AUTH_SECRET` only within server-executed calls, never module scope or a client component.
- The raw login secret and raw session token may not enter Mongo, activity, runner files, Discord, thrown client errors, or logs.
- Use `crypto.timingSafeEqual` only on same-length byte buffers; hash both candidate and expected strings first so comparison has a stable length.
- Every `createServerFn` except `login` must use the one authenticated path. `logout` requires a session too.
- No package additions and no auth bypass for tests. Tests set an explicit test secret before importing modules.
- Keep `boundary` available for direct core tests; authentication belongs to the server-function transport boundary.

## File structure

- Create `src/server/auth.server.ts` — secret comparison, opaque-token issue/hash/lookup/revoke and cookie parsing/response helpers.
- Create `src/server/auth.ts` — `login`, `logout`, `sessionStatus` server functions plus typed wire schemas.
- Create `src/server/auth.test.ts` — crypto/session/cookie unit tests against a throwaway Mongo database.
- Create `src/server/auth.smoke.test.ts` — authenticated-boundary and complete server-function inventory tests.
- Modify `src/server/result.ts` and `src/server/result.test.ts` — authenticated boundary and `unauthorized` union result.
- Modify `src/server/{boards,browse,chat,runs,specBundles,tickets}.ts` — mechanical boundary migration.
- Modify `src/routes/__root.tsx`, `src/routes/index.tsx`, and `src/styles.css` — unlock shell and logout control.
- Modify `.env.example` — document the required secret without a value.

### Task 1: Build the server-only session primitive

**Files:** create `src/server/auth.server.ts`, `src/server/auth.test.ts`; modify `.env.example`.

- [ ] Write tests first for: blank/missing secret rejects; equal and unequal secrets; token hashing; issued session has no raw token in Mongo; valid/expired/revoked token lookup; cookie parsing splits only on its first `=`; cookie output has `HttpOnly`, `SameSite=Strict`, `Path=/`, bounded `Max-Age`, and adds `Secure` only on HTTPS.
- [ ] Run `bun run test src/server/auth.test.ts`; confirm failure because the module does not exist.
- [ ] Implement `auth.server.ts` with these server-only APIs:

```ts
export const AuthSessionSchema = z.object({
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict()

export async function authenticateSecret(candidate: string): Promise<boolean>
export async function issueSession(): Promise<void>
export async function requireSession(): Promise<void>
export async function revokeCurrentSession(): Promise<void>
```

`issueSession` creates 32 random bytes encoded base64url, persists only SHA-256 hex, and sends the raw token through `Set-Cookie`. `requireSession` reads the cookie through TanStack's server request header API, hashes it, then requires a matching unexpired record. It throws `ServerResultError("unauthorized", "Unlock Tosin4dev to continue")` on every invalid session case.

- [ ] Re-run `bun run test src/server/auth.test.ts`; expect green.
- [ ] Revert one cookie flag and one expiry predicate individually; each corresponding test must fail on its own assertion. Restore both.
- [ ] Commit: `feat(auth): add opaque local session primitives`.

### Task 2: Add the compulsory authenticated boundary

**Files:** modify `src/server/result.ts`, `src/server/result.test.ts`; create `src/server/auth.smoke.test.ts`.

- [ ] Write a failing test proving `authenticatedBoundary` rejects without a session and does not call its core operation, then accepts a valid session and returns the existing `ServerResult` success shape.
- [ ] Implement the wrapper without changing `boundary`'s existing semantics:

```ts
export async function authenticatedBoundary<Schema extends z.ZodTypeAny, O>(
  schema: Schema,
  raw: unknown,
  run: (input: z.output<Schema>) => O | Promise<O>,
): Promise<ServerResult<O>> {
  return boundary(schema, raw, async (input) => {
    await requireSession()
    return run(input)
  })
}
```

The implementation imports `requireSession` from the server-only module. It may not call `run` before authentication.

- [ ] Add an inventory test that reads the seven business server-function files as source text and asserts each exported `createServerFn` handler calls `authenticatedBoundary(`; it must allow only `src/server/auth.ts`'s `login` handler to use the unauthenticated path.
- [ ] Run targeted tests, show RED then GREEN, and commit: `feat(auth): add an authenticated server-function boundary`.

### Task 3: Migrate every existing server-function wrapper

**Files:** modify `src/server/boards.ts`, `browse.ts`, `chat.ts`, `runs.ts`, `specBundles.ts`, `tickets.ts`; tests `auth.smoke.test.ts` plus their existing focused tests.

- [ ] Before editing, run the inventory test with a temporary expectation that all existing modules are protected; it must fail and name the unprotected modules.
- [ ] Replace only the import and invocation at each wrapper: `boundary` becomes `authenticatedBoundary`. Do not alter each schema, core function, HTTP method, DTO, or public function name.
- [ ] Run every module's existing test files plus `auth.smoke.test.ts`; confirm valid-session calls retain behaviour and an unauthenticated call never invokes a core operation.
- [ ] Run `bun run typecheck` and commit: `feat(auth): protect every board server function`.

### Task 4: Add unlock, session status, and logout flows

**Files:** create `src/server/auth.ts`; modify `src/routes/__root.tsx`, `src/routes/index.tsx`, `src/styles.css`; extend `auth.smoke.test.ts`.

- [ ] Write failing server-function tests: wrong secret returns the same `unauthorized` result as a missing secret; correct secret sets a session cookie and returns `{ ok: true }`; logout deletes the exact hashed record and clears the cookie; session status does not disclose token data.
- [ ] Implement strict wire schemas:

```ts
const LoginInputSchema = z.object({ secret: z.string().min(1) }).strict()
const EmptyInputSchema = z.object({}).strict()
```

`login` is POST and only validates the submitted secret then calls `issueSession`. `logout` is POST and passes through `authenticatedBoundary`. `sessionStatus` is GET and returns `{ unlocked: true }` only through the authenticated path; unauthenticated callers get the ordinary typed error result.

- [ ] In the root shell, use `sessionStatus` before rendering private children. Render a password-style unlock form on the error path; call `login`, invalidate the status query after success, and never store the secret in React state longer than the submit lifecycle. Add one logout button that calls `logout` then clears the query cache.
- [ ] Run focused auth tests and `bun run typecheck`; commit: `feat(auth): add the local unlock and logout flow`.

### Task 5: Make configuration and safety failure explicit

**Files:** modify `.env.example`, `README.md`; extend `auth.test.ts`, `auth.smoke.test.ts`.

- [ ] Write tests showing a missing or whitespace-only `TOSIN4DEV_AUTH_SECRET` rejects login and all protected functions with the same safe `unauthorized` response, without logging the attempted secret.
- [ ] Document exactly one new configuration line:

```dotenv
# Required local console unlock secret. Generate a long random value; never commit it.
TOSIN4DEV_AUTH_SECRET=
```

Update Quickstart to require setting it before `just dev`. Do not alter `DEV_HOST` or describe ingress as delivered.
- [ ] Run targeted auth tests, then `bun run test && bun run typecheck && bun run build` (one heavy gate only). The final suite must be evaluated for documented pre-existing flakes; repeat once only if the failure matches #19/#20/#28.
- [ ] Commit: `docs(auth): require a local unlock secret`.

### Task 6: Final proof and review packet

**Files:** no feature file changes unless a verification defect is found.

- [ ] Run `git diff --check`, `bun run test`, `bun run typecheck`, and `bun run build` on the exact commit to push.
- [ ] Review the diff against the auth spec: all server-function files are covered; only login is unauthenticated; no raw secret/token persistence; missing config fails closed; logout clears the server record and cookie.
- [ ] Open a draft PR linked to `Refs #23`, with the exact gate output and no claim that ingress is implemented.
