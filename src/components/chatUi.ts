import type { ChatSessionDTO } from "../server/chat";

// The chat session query polls only while a turn is in flight; idle/error are
// settled (mirrors runsUi.shouldPollRun's role for runs).
export function isChatTurnPending(status: ChatSessionDTO["turnStatus"]): boolean {
  return status === "pending";
}
