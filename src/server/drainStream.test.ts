import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainStream } from "./supervisor.server";
import { parseSessionId } from "./outcome.server";

async function drain(chunks: string[]): Promise<{ out: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "drain-"));
  const file = join(dir, "out.log");
  const stream = Readable.from(chunks.map((c) => Buffer.from(c, "utf8")));
  const out = await drainStream(stream, file, true);
  return { out, file };
}

describe("drainStream", () => {
  it("returns short output unchanged and with no marker", async () => {
    const { out } = await drain(["hello\n", "world\n"]);
    expect(out).toBe("hello\nworld\n");
    expect(out).not.toContain("truncated");
  });

  it("writes every byte to the log file even when the buffer truncates", async () => {
    const big = "x".repeat(700_000);
    const { file } = await drain(["first\n", big, "\nlast\n"]);
    const onDisk = await readFile(file, "utf8");
    expect(onDisk.length).toBe("first\n".length + big.length + "\nlast\n".length);
  });

  it("keeps BOTH the head and the tail when output exceeds the cap", async () => {
    const { out } = await drain(["HEADLINE\n", "x".repeat(700_000), "\nTAILLINE\n"]);
    expect(out).toContain("HEADLINE");
    expect(out).toContain("TAILLINE");
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThanOrEqual(512_000 + 64);
  });

  it("isolates the truncation marker on its own line", async () => {
    const { out } = await drain(["HEADLINE\n", "x".repeat(700_000), "\nTAILLINE\n"]);
    const markerLine = out.split("\n").find((l) => l.includes("truncated"));
    expect(markerLine).toBeDefined();
    // The marker must not be glued to real content on either side.
    expect(markerLine?.includes("HEADLINE")).toBe(false);
    expect(markerLine?.includes("x")).toBe(false);
  });

  // The actual regression: a long codex run must still yield its session id.
  it("preserves the codex thread_id through a >512KB stream", async () => {
    const { out } = await drain([
      '{"type":"thread.started","thread_id":"019f-abc"}\n',
      `${"y".repeat(700_000)}\n`,
      '{"type":"turn.completed"}\n',
    ]);
    expect(parseSessionId("codex", out)).toBe("019f-abc");
  });
});
