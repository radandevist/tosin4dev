const CONSULTATION_ANSWER_PREFIX = "tosin4dev:consultation-answer:";

export function consultationAnswerStorageKey(runId: string): string {
  return `${CONSULTATION_ANSWER_PREFIX}${runId}`;
}

export function parseConsultationTicketSeq(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
