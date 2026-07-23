import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainStream, parseSummary } from "./supervisor.server";
import { parseSessionId } from "./outcome.server";

const TRUNCATION_MARKER = "\n…[output truncated]…\n";

async function drain(
  chunks: string[],
  collect = true,
): Promise<{ out: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "drain-"));
  const file = join(dir, "out.log");
  const stream = Readable.from(chunks.map((c) => Buffer.from(c, "utf8")));
  const out = await drainStream(stream, file, collect);
  return { out, file };
}

describe("drainStream", () => {
  it("returns short output unchanged and with no marker", async () => {
    const { out } = await drain(["hello\n", "world\n"]);
    expect(out).toBe("hello\nworld\n");
    expect(out).not.toContain("truncated");
  });

  it("returns mid-size multi-chunk output byte-identically with no marker", async () => {
    const chunks = [
      "a".repeat(50_000),
      "b".repeat(70_000),
      "c".repeat(30_000),
      "d".repeat(50_000),
    ];
    const { out } = await drain(chunks);
    expect(out).toBe(chunks.join(""));
    expect(out).not.toContain("truncated");
  });

  it("adds a marker only after the exact collection boundary", async () => {
    const exact = `f${"x".repeat(511_998)}l`;
    const { out: exactOut } = await drain([exact]);
    expect(exactOut).toBe(exact);
    expect(exactOut).not.toContain("truncated");

    const over = `f${"x".repeat(511_999)}l`;
    const { out: overOut } = await drain([over]);
    expect(overOut).toContain(TRUNCATION_MARKER);
    expect(overOut[0]).toBe("f");
    expect(overOut.at(-1)).toBe("l");
    expect(overOut).toHaveLength(512_000 + TRUNCATION_MARKER.length);
  });

  it("preserves multi-chunk output that straddles the head boundary", async () => {
    const chunks = [
      "a".repeat(63_995),
      "b".repeat(10),
      "c".repeat(100_000),
    ];
    const { out } = await drain(chunks);
    expect(out).toBe(chunks.join(""));
    expect(out).not.toContain("truncated");
  });

  it("returns nothing when collection is disabled but logs every byte", async () => {
    const chunks = ["first\n", "😀".repeat(100_000), "\nlast\n"];
    const input = chunks.join("");
    const { out, file } = await drain(chunks, false);
    expect(out).toBe("");
    expect(await readFile(file, "utf8")).toBe(input);
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

  it("ignores an early SUMMARY header after truncation", async () => {
    const { out } = await drain([
      "SUMMARY\nscratch result\n",
      "x".repeat(700_000),
      "\nordinary tail output\n",
    ]);
    expect(parseSummary(out)).toBeNull();
  });

  it("returns a final SUMMARY section after truncation", async () => {
    const { out } = await drain([
      "early output\n",
      "x".repeat(700_000),
      "\nSUMMARY\nfinal result\n",
    ]);
    expect(parseSummary(out)).toBe("final result");
  });

  it("does not split an astral character at the head boundary", async () => {
    const { out } = await drain([
      "x".repeat(63_999),
      "😀",
      "y".repeat(700_000),
    ]);
    const wellFormed = out as string & { isWellFormed(): boolean };
    expect(wellFormed.isWellFormed()).toBe(true);
  });
});
