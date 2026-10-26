import { describe, expect, it } from "vitest";
import { selectEvidence } from "./evidence-selection";
import type { RetrievedRecord } from "./types";

function record(
  id: string,
  content: string,
  options: Partial<RetrievedRecord> = {},
): RetrievedRecord {
  return {
    result_id: id,
    result_kind: "chunk",
    content,
    source_filename: "minutes.docx",
    source_type: "docx",
    source_location: {},
    metadata: {},
    score: 0.8,
    ...options,
  };
}

describe("query-aware evidence selection", () => {
  it("does not let generic financial wording push auditor evidence out of the prompt", () => {
    const financialFact = record("fact", "Revenue: 100 ₹ crore", {
      result_kind: "fact",
      source_filename: "results.xlsx",
    });
    const reportConclusion = record(
      "conclusion",
      "Nothing has come to our attention that causes us to believe the Statement contains a material misstatement.",
      {
        source_filename: "Auditors_Limited_Review_Report.pdf",
        source_type: "pdf",
        source_location: { section: "1. Conclusion" },
      },
    );

    expect(selectEvidence(
      "What did the auditor conclude about the financial results?",
      [financialFact, reportConclusion],
    )[0]).toBe(reportConclusion);
  });

  it("keeps broad board questions from truncating decisions at the first six matches", () => {
    const decisions = Array.from({ length: 12 }, (_, index) =>
      record(`decision-${index}`, `Item ${index + 1} — decision and follow-up action`));

    expect(selectEvidence("What board decisions and follow-up actions were recorded?", decisions))
      .toHaveLength(12);
  });

  it("prioritizes requested metrics and reporting periods over unrelated facts", () => {
    const unrelated = record("oci", "Other comprehensive income: 2.1 ₹ crore", {
      result_kind: "fact",
      metadata: { row_label: "Other comprehensive income", period: "Q2 FY2026-27" },
    });
    const revenue = record("revenue", "Revenue from operations: 100 ₹ crore", {
      result_kind: "fact",
      metadata: { row_label: "Revenue from operations", period: "Q2 FY2026-27" },
    });
    const profit = record("profit", "Profit for the period: 20 ₹ crore", {
      result_kind: "fact",
      metadata: { row_label: "Profit for the period", period: "Q2 FY2026-27" },
    });

    expect(selectEvidence("What revenue and profit were reported for Q2 FY2026-27?", [
      unrelated,
      revenue,
      profit,
    ]).slice(0, 2)).toEqual([revenue, profit]);
  });

  it("retains every requested current-period metric and scope combination", () => {
    const facts = [
      ["revenue-q2-standalone", "Revenue from operations", "Q2 FY2026-27", "standalone"],
      ["revenue-q2-consolidated", "Revenue from operations", "Q2 FY2026-27", "consolidated"],
      ["revenue-h1-standalone", "Revenue from operations", "H1 FY2026-27", "standalone"],
      ["revenue-h1-consolidated", "Revenue from operations", "H1 FY2026-27", "consolidated"],
      ["profit-q2-standalone", "Profit for the period", "Q2 FY2026-27", "standalone"],
      ["profit-q2-consolidated", "Profit for the period", "Q2 FY2026-27", "consolidated"],
      ["profit-h1-standalone", "Profit for the period", "H1 FY2026-27", "standalone"],
      ["profit-h1-consolidated", "Profit for the period", "H1 FY2026-27", "consolidated"],
    ].map(([id, label, period, scope]) => record(id, `${label}: 100`, {
      result_kind: "fact",
      metadata: { row_label: label, period, scope },
    }));
    const previousYear = record("old-revenue", "Revenue from operations: 90", {
      result_kind: "fact",
      metadata: {
        row_label: "Revenue from operations",
        period: "Q2 FY2025-26",
        scope: "standalone",
      },
    });

    const selected = selectEvidence(
      "Compare revenue and profit for Q2 and H1 FY2026-27, standalone and consolidated.",
      [...facts, previousYear],
    );

    expect(selected.slice(0, 8).map((item) => item.result_id).sort())
      .toEqual(facts.map((item) => item.result_id).sort());
    expect(selected).not.toContain(previousYear);
  });

  it("prioritizes one source chunk from every returned board agenda item", () => {
    const decisions = Array.from({ length: 18 }, (_, index) => {
      const item = Math.floor(index / 2) + 1;
      return record(
        `decision-${item}-${index % 2 + 1}`,
        `Item ${item} — decision and follow-up action ${index % 2 + 1}`,
      );
    });

    expect(selectEvidence(
      "What board decisions and follow-up actions were recorded?",
      decisions,
    ).slice(0, 9).map((item) => item.result_id)).toEqual(
      Array.from({ length: 9 }, (_, index) => `decision-${index + 1}-1`),
    );
    expect(selectEvidence(
      "What board decisions and follow-up actions were recorded?",
      decisions,
    )).toHaveLength(16);
  });
});
