import { type Db, MongoClient, ObjectId } from "mongodb";

// ponytail: lazy singleton, fine for a single-process local app.
// Promise-based so concurrent callers await the same connect() instead of
// racing to observe a half-connected client (the naive `if (!client)` guard
// hands out client.db() before connect() resolves).
let connecting: Promise<Db> | null = null;

async function connect(): Promise<Db> {
  // Read the URI at first use so tests / callers can set it before connecting.
  const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/tosin4dev";
  const client = new MongoClient(uri);
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

  // One active run per ticket. Mongo partial filters reject $ne, so we match
  // "activeRunId is a string" ($type) instead of "activeRunId != null": every
  // set run id is a non-null string, every idle ticket carries null, and null
  // is excluded from the index. This unique index guards against duplicate
  // string run ids; the single scalar activeRunId field plus the later atomic
  // findOneAndUpdate dispatch guard (set activeRunId only when it is null) are
  // what actually enforce at-most-one active run per ticket.
  await database.collection("tickets").createIndex(
    { activeRunId: 1 },
    {
      unique: true,
      partialFilterExpression: { activeRunId: { $type: "string" } },
    },
  );

  return database;
}

export function db(): Promise<Db> {
  if (!connecting) {
    // Drop a failed attempt so a later call can retry instead of returning the
    // permanently-rejected promise.
    connecting = connect().catch((err) => {
      connecting = null;
      throw err;
    });
  }
  return connecting;
}

export { ObjectId };
