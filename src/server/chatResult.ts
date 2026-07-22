import {
  ChatDraftSchema,
  SpecBundleProposalSchema,
  type ChatDraft,
  type SpecBundleProposal,
} from "../domain/schemas";
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

export function parseTurn(
  provider: "claude" | "codex",
  stdout: string,
): { result: string; sessionId: string | null } | null {
  if (provider === "claude") return parseChatResult(stdout);
  let text: string | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const item = obj?.item as Record<string, unknown> | undefined;
      if (
        obj?.type === "item.completed" &&
        item?.type === "agent_message" &&
        typeof item.text === "string"
      ) {
        text = item.text;
      }
    } catch {
      continue;
    }
  }
  if (text === null) return null;
  return { result: text, sessionId: parseSessionId("codex", stdout) };
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

// Structural validity of a bundle's members: unique/non-empty localKeys, every
// dependsOn references an existing key, no self-dependency, no cycles. Returns
// an error message (for turnError) or null when valid. Pure.
export function validateBundleMembers(
  members: { localKey: string; dependsOn: string[] }[],
): string | null {
  if (members.length === 0) return "a bundle needs at least one ticket";
  const keys = new Set<string>();
  for (const m of members) {
    if (!m.localKey || m.localKey.trim() === "") return "every ticket needs a localKey";
    if (keys.has(m.localKey)) return `duplicate localKey: ${m.localKey}`;
    keys.add(m.localKey);
  }
  for (const m of members) {
    for (const dep of m.dependsOn) {
      if (dep === m.localKey) return `${m.localKey} cannot depend on itself`;
      if (!keys.has(dep)) return `${m.localKey} depends on unknown key: ${dep}`;
    }
  }
  const byKey = new Map(members.map((m) => [m.localKey, m.dependsOn]));
  const state = new Map<string, 1 | 2>(); // 1 = visiting, 2 = done
  const visit = (k: string): boolean => {
    const s = state.get(k);
    if (s === 1) return false; // back-edge → cycle
    if (s === 2) return true;
    state.set(k, 1);
    for (const dep of byKey.get(k) ?? []) if (!visit(dep)) return false;
    state.set(k, 2);
    return true;
  };
  for (const m of members) if (!visit(m.localKey)) return `dependency cycle involving ${m.localKey}`;
  return null;
}

// Parse the model's bundle proposal text into a validated SpecBundleProposal.
// Tolerates a ```json fence; schema-invalid → null (fail-closed). Structural
// (dependency/cycle) validation is done separately by validateBundleMembers so
// the caller can surface a specific message.
export function parseBundle(text: string): SpecBundleProposal | null {
  const candidates = [text.trim(), extractFenced(text), extractBraces(text)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = SpecBundleProposalSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      continue;
    }
  }
  return null;
}
