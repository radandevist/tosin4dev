# Local Shared-Secret Authentication — Design Spec

Date: 2026-08-12
Status: approved for design; implementation requires this document's review
Tracking: #23

## Goal

Protect every Tosin4dev server mutation and read from unauthenticated local callers, while keeping the product a single-operator local tool. This is not multi-user identity, roles, or remote access.

## Problem

Loopback binding prevents other LAN devices from reaching the development server by default, but any local process that can reach `127.0.0.1:3141` can currently call a server function. Because a board accepts a local repository path and execution starts a workspace-writing agent, this is more serious than ordinary local data access.

The protection must be structural: adding a future `createServerFn` without authentication must fail tests instead of relying on an author remembering a wrapper.

## Chosen design

### Configuration

`TOSIN4DEV_AUTH_SECRET` is required in `.env` for normal application startup. It is never placed in browser code, tickets, run files, logs, or responses. `.env.example` documents the variable without a value.

In test mode, an explicit test-only setup may set the variable before importing the server boundary. Production code must fail closed when it is absent or blank.

### Login and session

The root route displays a minimal unlock form whenever no valid session exists. The form submits the supplied secret to one dedicated server function.

The server compares the submitted value to `TOSIN4DEV_AUTH_SECRET` in constant time. On success, it creates a random opaque session value, stores only a SHA-256 digest with an expiry in a small Mongo `authSessions` collection, and sends the raw value in a `HttpOnly`, `SameSite=Strict`, `Path=/` cookie. The cookie is `Secure` when the request is HTTPS. The session lasts 12 hours and is renewed only by logging in again.

On failure, the response is deliberately identical for a wrong or missing secret. It must not reveal whether the configuration exists or why comparison failed. Logout deletes the server-side session and clears the cookie.

### One compulsory server boundary

Create a single authenticated wrapper around the existing `boundary(schema, raw, run)` pattern. It will:

1. parse and validate caller input;
2. read and validate the session cookie;
3. look up its digest and expiry;
4. return the existing typed `unauthorized` result on any missing, invalid, expired, or revoked session; and
5. call the core operation only after authentication.

Every `createServerFn` in the application, including reads, must use this authenticated wrapper. Core server modules remain independently testable and do not take browser/session parameters.

The unlock and logout functions are the only deliberate exceptions. They use a narrow unauthenticated wrapper that accepts only their own schemas; no business operation may be passed to it.

### Client behaviour

Queries and mutations that receive `unauthorized` clear any stale local UI state and redirect to the unlock page. The client never retries an authentication failure automatically.

The normal application remains unavailable until unlocked. There is no anonymous board listing, ticket content, run logs, filesystem browsing, agent dispatch, or chat access.

## Data model

An `authSessions` document contains only:

```ts
{
  tokenHash: string; // SHA-256 hex digest, unique
  expiresAt: string; // ISO timestamp
  createdAt: string; // ISO timestamp
}
```

No user identity is stored: this release has one local operator. A TTL index is optional hygiene, not authorization; every lookup also checks `expiresAt` itself.

## Error handling

- No configured secret, blank configured secret, malformed cookie, unknown token, expired token, and failed comparison all fail closed.
- Auth records and presented secrets are never sent to `console.error`, activity logs, Discord, or the client.
- Mongo read failure during authentication fails closed as `unauthorized` or a generic internal result; it never grants access.
- A session is valid only after both digest lookup and expiry check succeed.

## Proof requirements

1. A valid login creates a cookie-backed session; a protected core/server function becomes callable.
2. A missing, wrong, tampered, expired, or logged-out session returns `unauthorized` and does not invoke the core operation.
3. A missing/blank configuration fails closed.
4. The session database record never contains the raw secret or raw cookie token.
5. A repository-wide test enumerates the modules using `createServerFn` and rejects any non-auth function that does not use the authenticated wrapper. The designated unlock/logout exceptions are named explicitly in that test.
6. Existing direct core-function tests remain valid: authentication is enforced only at the transport/server-function boundary.

## Non-goals

- No remote/LAN binding change.
- No multi-user accounts, usernames, role model, password reset, OAuth, or external identity provider.
- No external ticket ingress implementation. It remains deferred even though this design is its prerequisite.
- No change to agent worktree permissions or runner sandboxes.

## Alternatives rejected

**A static browser token.** Easier to add, but it exposes the long-lived secret to browser JavaScript and has no revocation or expiry.

**A secret check copied into each server function.** It is easy to miss on a new endpoint; the desired invariant is structural, not remembered.

**Full multi-user authentication.** It solves a different problem and would add account, recovery, authorization, and operational complexity before there is a demonstrated need.
