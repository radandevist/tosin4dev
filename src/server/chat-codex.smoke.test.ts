import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DB = `tosin4dev-test-chat-codex-${process.pid}-${Date.now()}`;
const FIXED_THREAD_ID = "codex-thread-fixed";
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const ORIGINAL_ARGV_LOG = process.env.FAKE_CODEX_ARGV_LOG;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;
process.env.DISCORD_WEBHOOK_URL = "";

const { db, closeDb } = await import("./db");
const {
  createChatSessionCore,
  getChatSessionCore,
  proposeBundleFromChatCore,
  sendChatMessageCore,
} = await import("./chat.server");

let database: Db;
let repo: string;
let binDir: string;
let argvLog: string;
let boardId: string;

// The fake validates the real codex argv shape, records every invocation, and
// emits the captured codex JSONL schema. Prompt cases select scenario replies.
async function writeRunner(): Promise<void> {
  const exe = join(binDir, "codex");
  await writeFile(
    exe,
    `#!/bin/sh
for ARG in "$@"; do
  printf '%s\\t' "$ARG" >> "$FAKE_CODEX_ARGV_LOG"
done
printf '\\n' >> "$FAKE_CODEX_ARGV_LOG"

if [ "$1" != "-C" ] || [ -z "$2" ] || [ "$3" != "-s" ] || [ "$4" != "read-only" ] || [ "$5" != "exec" ]; then
  echo "unexpected codex argv prefix" >&2
  exit 8
fi
shift 5
RESUMED=0
if [ "$1" = "resume" ]; then
  if [ "$2" != "${FIXED_THREAD_ID}" ]; then
    echo "unexpected resume thread id" >&2
    exit 9
  fi
  RESUMED=1
  shift 2
fi
if [ "$1" != "--json" ] || [ "$#" -ne 2 ]; then
  echo "unexpected codex exec arguments" >&2
  exit 10
fi
PROMPT="$2"

printf '%s\\n' '{"type":"thread.started","thread_id":"${FIXED_THREAD_ID}"}'
printf '%s\\n' '{"type":"turn.started"}'
case "$PROMPT" in
  *"ONLY a JSON object"*)
    printf '%s\\n' '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"{\\"rationale\\":\\"split by concern\\",\\"members\\":[{\\"localKey\\":\\"t1\\",\\"title\\":\\"Add login\\",\\"type\\":\\"implement\\",\\"runner\\":\\"codex\\",\\"spec\\":{\\"intent\\":\\"add login\\",\\"scope\\":\\"authentication\\",\\"nonGoals\\":\\"oauth\\",\\"acceptance\\":[\\"users can log in\\"],\\"links\\":[],\\"risk\\":\\"low\\"},\\"dependsOn\\":[]}] }"}}'
    ;;
  "again")
    if [ "$RESUMED" -ne 1 ]; then
      echo "missing exec resume ${FIXED_THREAD_ID}" >&2
      exit 11
    fi
    printf '%s\\n' '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"codex reply: again"}}'
    ;;
  "error only")
    printf '%s\\n' '{"type":"item.completed","item":{"id":"item_1","type":"error","message":"fake codex error"}}'
    ;;
  "recover")
    printf '%s\\n' '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"codex reply: recovered"}}'
    ;;
  *)
    printf '%s\\n' '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"codex reply: hello"}}'
    ;;
esac
printf '%s\\n' '{"type":"turn.completed","usage":{}}'
exit 0
`,
  );
  await chmod(exe, 0o755);
}

async function waitForIdle(sessionId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await getChatSessionCore({ sessionId });
    if (session.turnStatus !== "pending") return session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("codex chat turn did not settle");
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "t4d-chat-codex-repo-"));
  binDir = await mkdtemp(join(tmpdir(), "t4d-chat-codex-bin-"));
  argvLog = join(binDir, "argv.log");
  execFileSync("git", ["init", "-b", "main", repo]);
  process.env.PATH = `${binDir}:${ORIGINAL_PATH ?? ""}`;
  process.env.FAKE_CODEX_ARGV_LOG = argvLog;
  await writeRunner();
  database = await db();
  const at = new Date().toISOString();
  const board = await database.collection("boards").insertOne({
    slug: `chat-codex-${process.pid}-${Date.now()}`,
    name: "Codex Chat",
    repoPath: repo,
    defaultBaseBranch: "main",
    checks: [],
    createdAt: at,
    updatedAt: at,
  });
  boardId = board.insertedId.toString();
});

afterAll(async () => {
  await database?.dropDatabase();
  await closeDb();
  process.env.PATH = ORIGINAL_PATH;
  process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;
  process.env.DISCORD_WEBHOOK_URL = ORIGINAL_WEBHOOK;
  process.env.FAKE_CODEX_ARGV_LOG = ORIGINAL_ARGV_LOG;
  await Promise.all([
    rm(repo, { recursive: true, force: true }),
    rm(binDir, { recursive: true, force: true }),
  ]);
});

describe("codex chat provider", () => {
  it("captures the thread id, appends replies, and resumes the second turn", async () => {
    const { id } = await createChatSessionCore({ boardId, provider: "codex" });

    await sendChatMessageCore({ sessionId: id, text: "hello" });
    const first = await waitForIdle(id);
    expect(first.turnStatus).toBe("idle");
    expect(first.sessionId).toBe(FIXED_THREAD_ID);
    expect(first.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(first.messages[1].text).toBe("codex reply: hello");

    await sendChatMessageCore({ sessionId: id, text: "again" });
    const second = await waitForIdle(id);
    expect(second.turnStatus).toBe("idle");
    expect(second.sessionId).toBe(FIXED_THREAD_ID);
    expect(second.messages).toHaveLength(4);
    expect(second.messages[3].text).toBe("codex reply: again");

    const invocations = (await readFile(argvLog, "utf8")).trim().split("\n");
    expect(invocations[1].split("\t")).toEqual([
      "-C",
      repo,
      "-s",
      "read-only",
      "exec",
      "resume",
      FIXED_THREAD_ID,
      "--json",
      "again",
    ]);
  });

  it("stores a drafting bundle from codex agent message text", async () => {
    const { id } = await createChatSessionCore({ boardId, provider: "codex" });
    await proposeBundleFromChatCore({ sessionId: id });
    const session = await waitForIdle(id);

    expect(session.turnStatus).toBe("idle");
    expect(session.sessionId).toBe(FIXED_THREAD_ID);
    expect(session.bundleId).not.toBeNull();
    const bundle = await database.collection("specBundles").findOne({
      sessionId: id,
    });
    expect(bundle?._id.toString()).toBe(session.bundleId);
    expect(bundle?.status).toBe("drafting");
    expect(bundle?.rationale).toBe("split by concern");
    expect(bundle?.members).toHaveLength(1);
    expect(bundle?.members[0].localKey).toBe("t1");
  });

  it("fails closed without an agent message and remains retryable", async () => {
    const { id } = await createChatSessionCore({ boardId, provider: "codex" });
    await sendChatMessageCore({ sessionId: id, text: "error only" });
    const failed = await waitForIdle(id);
    expect(failed.turnStatus).toBe("error");
    expect(failed.turnError).toContain("no parseable reply");
    expect(failed.messages).toHaveLength(1);

    await sendChatMessageCore({ sessionId: id, text: "recover" });
    const recovered = await waitForIdle(id);
    expect(recovered.turnStatus).toBe("idle");
    expect(recovered.turnError).toBeNull();
    expect(recovered.sessionId).toBe(FIXED_THREAD_ID);
    expect(recovered.messages.at(-1)?.text).toBe("codex reply: recovered");
  });
});
