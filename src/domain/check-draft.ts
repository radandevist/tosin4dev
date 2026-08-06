import { DEFAULT_CHECK_TIMEOUT_MS, type BoardCheck } from "./schemas";

// The editor's working row type. Deliberately NOT BoardCheck: a half-typed row
// (empty key, NaN timeout) produces an invalid check, and the boundary schema
// (UpdateBoardChecksSchema) is the single authority that decides what is valid.
//
// `command` holds the argv itself — one element per argument. A newline-delimited
// encoding (join("\n") / split("\n")) is not injective: an argument containing a
// newline silently re-encodes into several arguments the moment any other field
// is saved, rewriting a hand-authored check into a different command. `timeoutMs`
// mirrors an <input> value: a cleared field must be "" not 0, so Number("")=0
// fails the schema's `.positive()` visibly instead of silently passing 0.
export type DraftCheck = {
  key: string;
  label: string;
  command: string[];
  timeoutMs: string;
};

// The wire shape a completed row submits. Structurally assignable to BoardCheck
// where the boundary expects BoardCheck[], so `updateChecks.mutate` needs no cast.
export type DraftCheckPayload = {
  key: string;
  label: string;
  command: string[];
  timeoutMs: number;
};

export const emptyDraftCheck = (): DraftCheck => ({
  key: "",
  label: "",
  // argv[0] is the executable, so a zero-argument command is not a partially-
  // typed check — it is an unrepresentable one. Start and stay at [""].
  command: [""],
  timeoutMs: String(DEFAULT_CHECK_TIMEOUT_MS),
});

export const draftFromCheck = (check: BoardCheck): DraftCheck => ({
  key: check.key,
  label: check.label,
  command: [...check.command],
  timeoutMs: String(check.timeoutMs),
});

export const payloadFromDraft = (draft: DraftCheck): DraftCheckPayload => ({
  key: draft.key,
  label: draft.label,
  command: [...draft.command],
  timeoutMs: Number(draft.timeoutMs),
});

// The ONLY place drafts are transformed on the way out: rows in, the same rows
// out, never fewer. Dropping a row here would turn "operator typed a key and
// label but no command" into a reported success over discarded work. Let the
// boundary schema reject the incomplete row so the save fails visibly and the
// draft survives for the operator to fix.
export const payloadsFromDrafts = (
  drafts: DraftCheck[],
): DraftCheckPayload[] => drafts.map(payloadFromDraft);
