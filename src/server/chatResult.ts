import { ChatDraftSchema, type ChatDraft } from "../domain/schemas";
import { parseSessionId } from "./outcome.server";

// Pull the final assistant text + provider session id out of a claude
// --output-format json turn. Returns null if no `result` string is present.
export function parseChatResult(
  stdout: string,
): { result: string; sessionId: string | null } | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj && typeof obj === "object" && typeof obj.result === "string") {
        return { result: obj.result, sessionId: parseSessionId("claude", stdout) };
      }
    } catch {
      continue;
    }
  }
  return null;
}

// Parse the model's drafted spec text into a validated ChatDraft. Tolerates a
// ```json fence; anything not matching the schema fails closed (null).
export function parseDraft(text: string): ChatDraft | null {
  const candidates = [text.trim(), extractFenced(text), extractBraces(text)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = ChatDraftSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      continue;
    }
  }
  return null;
}

function extractFenced(text: string): string | null {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return m ? m[1].trim() : null;
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}
