import { type Db, MongoClient, ObjectId } from "mongodb";

// ponytail: lazy singleton, fine for a single-process local app.
// The connecting promise is cached on globalThis, not a module-scoped `let`,
// because Vite's dev server re-evaluates this module on every HMR update. A
// module-local cache would be reset on each reload and leak a fresh MongoClient
// (and its connection pool) each time; the globalThis slot survives reloads so
// we keep reusing one client.
//
// Promise-based so concurrent callers await the same connect() instead of
// racing to observe a half-connected client (the naive `if (!client)` guard
// hands out client.db() before connect() resolves).
const globalForDb = globalThis as typeof globalThis & {
  __tosin4devDb?: Promise<Db> | null;
};

async function connect(): Promise<Db> {
  // Read the URI at first use so tests / callers can set it before connecting.
  const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/tosin4dev";
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const database = client.db();

    // createIndex is idempotent: identical spec + options is a no-op after the
    // first call, so running these on every cold start is safe.
    await database
      .collection("boards")
      .createIndex({ slug: 1 }, { unique: true });
    await database
      .collection("tickets")
      .createIndex({ boardId: 1, seq: 1 }, { unique: true });

    // Unique partial index on activeRunId. Mongo partial filters reject $ne, so
    // we match "activeRunId is a string" ($type) instead of "activeRunId !=
    // null": every set run id is a non-null string, every idle ticket carries
    // null, and null is excluded from the index.
    //
    // This index only guarantees that a given run id is never attached to two
    // tickets at once — it does NOT enforce at-most-one active run per ticket
    // (a single scalar activeRunId field already holds just one value). That
    // per-ticket concurrency guard is Task 7's job: an atomic findOneAndUpdate
    // that claims a ticket only while its activeRunId is null.
    await database.collection("tickets").createIndex(
      { activeRunId: 1 },
      {
        unique: true,
        partialFilterExpression: { activeRunId: { $type: "string" } },
      },
    );

    return database;
  } catch (err) {
    // Connection or index initialization failed. Close the (possibly
    // half-open) client so we don't leak its connection pool, then rethrow so
    // db() can clear the cache and let a later call retry from scratch.
    await client.close().catch(() => {});
    throw err;
  }
}

export function db(): Promise<Db> {
  if (!globalForDb.__tosin4devDb) {
    // Drop a failed attempt so a later call can retry instead of returning the
    // permanently-rejected promise.
    globalForDb.__tosin4devDb = connect().catch((err) => {
      globalForDb.__tosin4devDb = null;
      throw err;
    });
  }
  return globalForDb.__tosin4devDb;
}

export { ObjectId };
