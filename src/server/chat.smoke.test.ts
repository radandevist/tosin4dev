import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DB = `tosin4dev-test-chat-${process.pid}-${Date.now()}`;
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;
process.env.DISCORD_WEBHOOK_URL = "";

const { db, closeDb } = await import("./db");
const {
  createChatSessionCore,
  sendChatMessageCore,
  getChatSessionCore,
} = await import("./chat.server");

let database: Db;
let repo: string;
let binDir: string;
let boardId: string;

// The fake claude fails unless the second chat turn resumes s-chat, returns a
// valid draft when prompted, and exposes deterministic failure/recovery turns.
async function writeRunner(): Promise<void> {
  const exe = join(binDir, "claude");
  await writeFile(
    exe,
    `#!/bin/sh
# args: -p <text> --output-format json [--resume <sid>]
PROMPT="$2"
RESUMED=0
PREVIOUS=""
for ARG in "$@"; do
  if [ "$PREVIOUS" = "--resume" ] && [ "$ARG" = "s-chat" ]; then
    RESUMED=1
  fi
  PREVIOUS="$ARG"
done
case "$PROMPT" in
  *"ONLY a JSON object"*)
    RESULT='{\\"title\\":\\"Add login\\",\\"type\\":\\"implement\\",\\"runner\\":\\"claude\\",\\"spec\\":{\\"intent\\":\\"add login\\",\\"scope\\":\\"\\",\\"nonGoals\\":\\"\\",\\"acceptance\\":[],\\"links\\":[],\\"risk\\":\\"low\\"}}'
    ;;
  "again")
    if [ "$RESUMED" -ne 1 ]; then
      echo "missing --resume s-chat" >&2
      exit 9
    fi
    RESULT="reply to: $PROMPT"
    ;;
  "hold")
    sleep 1
    RESULT="reply to: $PROMPT"
    ;;
  "fail")
    echo "broken turn" >&2
    exit 7
    ;;
  *) RESULT="reply to: $PROMPT" ;;
esac
printf '%s\\n' "{\\"type\\":\\"result\\",\\"session_id\\":\\"s-chat\\",\\"result\\":\\"$RESULT\\"}"
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
  throw new Error("chat turn did not settle");
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "t4d-chat-repo-"));
  binDir = await mkdtemp(join(tmpdir(), "t4d-chat-bin-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  process.env.PATH = `${binDir}:${ORIGINAL_PATH ?? ""}`;
  await writeRunner();
  database = await db();
  const at = new Date().toISOString();
  const board = await database.collection("boards").insertOne({
    slug: `chat-${process.pid}-${Date.now()}`,
    name: "Chat",
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
  await Promise.all([
    rm(repo, { recursive: true, force: true }),
    rm(binDir, { recursive: true, force: true }),
  ]);
});

describe("chat slice", () => {
  it("sends a message, captures session id, and resumes the next turn", async () => {
    const { id } = await createChatSessionCore({ boardId });
    await sendChatMessageCore({ sessionId: id, text: "hello" });
    const first = await waitForIdle(id);
    expect(first.turnStatus).toBe("idle");
    expect(first.sessionId).toBe("s-chat");
    expect(first.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(first.messages[1].text).toContain("reply to: hello");

    await sendChatMessageCore({ sessionId: id, text: "again" });
    const second = await waitForIdle(id);
    expect(second.turnStatus).toBe("idle");
    expect(second.messages).toHaveLength(4);
    expect(second.messages[3].text).toContain("reply to: again");
  });

  it("rejects overlap, records an error turn, and remains usable", async () => {
    const { id: pendingId } = await createChatSessionCore({ boardId });
    await sendChatMessageCore({ sessionId: pendingId, text: "hold" });
    await expect(
      sendChatMessageCore({ sessionId: pendingId, text: "two" }),
    ).rejects.toThrow(/in progress/);
    await waitForIdle(pendingId);

    const { id } = await createChatSessionCore({ boardId });
    await sendChatMessageCore({ sessionId: id, text: "fail" });
    const failed = await waitForIdle(id);
    expect(failed.turnStatus).toBe("error");
    expect(failed.turnError).toContain("code 7");

    await sendChatMessageCore({ sessionId: id, text: "recover" });
    const recovered = await waitForIdle(id);
    expect(recovered.turnStatus).toBe("idle");
    expect(recovered.turnError).toBeNull();
    expect(recovered.messages.at(-1)?.text).toContain("reply to: recover");
  });
});
