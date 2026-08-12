import { readFile, writeFile } from "node:fs/promises";
import { DraftedSpecSchema, type DraftedSpec } from "../domain/schemas";

// Spec-draft runners run in a READ-ONLY sandbox (codex --sandbox read-only),
// so the artifact contract is bounded structured STDOUT: the runner prints
// the spec JSON between these marker lines and Tosin-owned code writes
// <runDir>/spec.json from it. The LAST block wins so early scratch output is
// never captured, and the block is size-bounded so a runaway draft cannot
// balloon the run directory.
export const SPEC_JSON_START = "SPEC_JSON_START";
export const SPEC_JSON_END = "SPEC_JSON_END";
export const SPEC_BLOCK_CAP = 32_768;

// Extract the bounded structured spec block from a runner's stdout. Fail-closed
// like readDraftedSpec: no block, an oversized block, unparseable JSON or a
// schema violation all yield null, so the caller never applies a partial spec.
export function extractDraftedSpecBlock(stdout: string): DraftedSpec | null {
  const lines = stdout.replace(/\r\n?/g, "\n").split("\n");
  // The prompt says the markers occupy their own lines. Requiring exact lines
  // prevents prose or a JSON string that merely mentions a marker from being
  // treated as an artifact boundary. The last start wins so scratch blocks do
  // not override the runner's final draft.
  let startLine = -1;
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] === SPEC_JSON_START) startLine = index;
  }
  if (startLine < 0) return null;
  const endLine = lines.indexOf(SPEC_JSON_END, startLine + 1);
  if (endLine < 0) return null;
  const block = lines.slice(startLine + 1, endLine).join("\n").trim();
  if (block.length === 0 || block.length > SPEC_BLOCK_CAP) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(block);
  } catch {
    return null;
  }
  const parsed = DraftedSpecSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

// Parse a runner's bounded structured stdout and write the spec.json artifact
// applyDraftedSpec reads. Returns null (and writes nothing) on any failure.
export async function captureDraftedSpec(
  stdout: string,
  runDir: string,
): Promise<DraftedSpec | null> {
  const draft = extractDraftedSpecBlock(stdout);
  if (!draft) return null;
  await writeFile(`${runDir}/spec.json`, JSON.stringify(draft, null, 2));
  return draft;
}

// Read + validate <runDir>/spec.json. Fail-closed like readOutcome: a missing,
// unreadable, unparseable or invalid file yields null, and the caller leaves
// the ticket alone. A partially-applied spec is worse than none — it looks
// approval-ready while missing the acceptance criteria the contract rests on.
export async function readDraftedSpec(
  runDir: string,
): Promise<DraftedSpec | null> {
  let raw: string;
  try {
    raw = await readFile(`${runDir}/spec.json`, "utf8");
  } catch {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = DraftedSpecSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}
