import { describe, expect, it } from "vitest";
import {
  consultationAnswerStorageKey,
  parseConsultationTicketSeq,
} from "./consultationUi";

describe("consultation UI helpers", () => {
  it("scopes copied answers to their parked run", () => {
    expect(consultationAnswerStorageKey("run-123")).toBe(
      "tosin4dev:consultation-answer:run-123",
    );
  });

  it("accepts only positive integer ticket sequences", () => {
    expect(parseConsultationTicketSeq(12)).toBe(12);
    expect(parseConsultationTicketSeq("12")).toBe(12);
    expect(parseConsultationTicketSeq("")).toBeNull();
    expect(parseConsultationTicketSeq(0)).toBeNull();
    expect(parseConsultationTicketSeq("1.5")).toBeNull();
    expect(parseConsultationTicketSeq(undefined)).toBeNull();
  });
});
