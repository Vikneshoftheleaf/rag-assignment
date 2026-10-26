import { describe, expect, it } from "vitest";
import { getRetrievalMatchPercent, toFeedbackSources } from "./turn-feedback";
import type { RetrievedRecord } from "./types";

const record: RetrievedRecord = {
  result_id: "source-id",
  result_kind: "chunk",
  content: "A board decision.",
  source_filename: "minutes.docx",
  source_type: "docx",
  source_location: { page: 2 },
  metadata: {},
  score: 0.6,
  retrieval_score: 0.8,
};

describe("retrieval feedback context", () => {
  it("stores the original retrieval score and source provenance", () => {
    expect(toFeedbackSources([record])).toEqual([{
      sourceId: "source-id",
      kind: "chunk",
      content: "A board decision.",
      filename: "minutes.docx",
      location: { page: 2 },
      score: 0.8,
    }]);
  });

  it("reports a bounded mean score for the top five pieces of evidence", () => {
    expect(getRetrievalMatchPercent([{ score: 0.8 }, { score: 0.6 }])).toBe(70);
    expect(getRetrievalMatchPercent([{ score: 2 }, { score: -1 }])).toBe(50);
    expect(getRetrievalMatchPercent([])).toBeNull();
  });
});
