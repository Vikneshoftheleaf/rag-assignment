import { describe, expect, it } from "vitest";
import { formatCitations, formatLocation, keepCitedSources } from "./retrieval";
import type { RetrievedRecord } from "./types";

const sample: RetrievedRecord = {
  result_id: "uuid",
  result_kind: "fact",
  content: "Revenue — H1: 120",
  source_filename: "results.xlsx",
  source_type: "xlsx",
  source_location: { sheet: "H1 Results", row: 8, cell: "C8" },
  metadata: {},
  score: 0.8,
};

describe("citation formatting", () => {
  it("provides stable reference labels and source context", () => {
    expect(formatCitations([sample])[0]).toEqual({
      id: "S1",
      filename: "results.xlsx",
      documentType: "xlsx",
      location: { sheet: "H1 Results", row: 8, cell: "C8" },
      excerpt: "Revenue — H1: 120",
      kind: "fact",
    });
  });

  it("formats locations without inventing missing fields", () => {
    expect(formatLocation({ page: 3, section: "Results" })).toBe("page: 3 · section: Results");
    expect(formatLocation({})).toBe("Source excerpt");
  });

  it("returns only sources cited in the answer, in citation order", () => {
    const citations = formatCitations([sample, { ...sample, result_id: "second", source_filename: "minutes.docx" }]);
    const result = keepCitedSources("Revenue was reported [S2]. Details are in [S2] and [S1].", citations);

    expect(result.answer).toBe("Revenue was reported [S2]. Details are in [S2] and [S1].");
    expect(result.citations.map((citation) => citation.id)).toEqual(["S2", "S1"]);
  });

  it("removes invalid citation labels and adds a valid source if the model omitted citations", () => {
    const citations = formatCitations([sample]);

    expect(keepCitedSources("Unsupported label [S7]", citations)).toEqual({
      answer: "Unsupported label [S1]",
      citations,
    });
    expect(keepCitedSources("A supported answer.", citations)).toEqual({
      answer: "A supported answer. [S1]",
      citations,
    });
  });
});
