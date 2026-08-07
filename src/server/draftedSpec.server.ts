import { readFile } from "node:fs/promises";
import { DraftedSpecSchema, type DraftedSpec } from "../domain/schemas";

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
