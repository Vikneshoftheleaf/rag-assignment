import { describe, expect, it } from "vitest";
import {
  classifyNumericQuery,
  classifyNumericFollowUp,
  exactFactCitations,
  resolveNumericLookup,
} from "./numeric-lookup";
import type { RetrievedRecord } from "./types";

function fact(
  id: string,
  rowLabel: string,
  period: string,
  value: string,
  scope = "standalone",
): RetrievedRecord {
  return {
    result_id: id,
    result_kind: "fact",
    content: `${rowLabel}: ${value} ₹ crore (${period}) [${scope}]`,
    source_filename: "results.xlsx",
    source_type: "xlsx",
    source_location: { sheet: "Results", row: 7, cell: id },
    metadata: {
      row_label: rowLabel,
      period,
      scope,
      unit: "₹ crore",
      value_text: value,
      numeric_value: Number(value),
    },
    score: 1,
  };
}

describe("exact numeric lookup", () => {
  const revenueQ2 = fact("B7", "I. Revenue from operations", "Q2 FY2026-27", "1245.6");

  it("recognizes a bare workbook sheet title as a sheet overview request", () => {
    expect(classifyNumericQuery("balance sheet")).toEqual({
      kind: "lookup",
      query: {
        metricLabel: "Balance Sheet",
        metricSearchTerms: [],
        periods: [],
        fiscalYear: null,
        scope: null,
        compare: false,
        bothScopes: true,
        sheetName: "Balance Sheet",
      },
    });
    expect(classifyNumericQuery("Show me the Balance Sheet")).toMatchObject({
      kind: "lookup",
      query: { sheetName: "Balance Sheet", metricSearchTerms: [] },
    });
    expect(classifyNumericQuery("What is in the Balance Sheet?")).toMatchObject({
      kind: "lookup",
      query: { sheetName: "Balance Sheet" },
    });
    expect(classifyNumericQuery("What was cash in the balance sheet?").kind).toBe("not_numeric");
  });

  it("extracts a metric, period, and scope from a numeric question", () => {
    expect(classifyNumericQuery("What was standalone revenue for Q2 FY2026-27?")).toEqual({
      kind: "lookup",
      query: {
        metricLabel: "revenue",
        metricSearchTerms: ["revenue", "turnover", "sales"],
        periods: ["Q2 FY2026-27"],
        fiscalYear: "FY2026-27",
        scope: "standalone",
        compare: false,
        bothScopes: false,
      },
    });
  });

  it("routes explicit quarter-ended column headers to exact cell lookup", () => {
    const classification = classifyNumericQuery(
      "Revenue from operations - Quarter ended 30-Sep-2026",
    );

    expect(classification).toMatchObject({
      kind: "lookup",
      query: {
        metricLabel: "revenue",
        metricSearchTerms: ["revenue", "turnover", "sales"],
        columnSearchTerms: ["Quarter ended 30-Sep-2026"],
        periods: [],
        fiscalYear: null,
        scope: null,
      },
    });
    if (classification.kind !== "lookup") throw new Error("Expected numeric lookup classification.");

    const result = resolveNumericLookup(classification.query, [
      fact("B7", "I. Revenue from operations", "Q2 FY2026-27", "1245.6", "standalone"),
      fact("B7-consolidated", "I. Revenue from operations", "Q2 FY2026-27", "1378.4", "consolidated"),
    ]);

    expect(result.kind).toBe("abstain");
    if (result.kind !== "abstain") return;
    expect(result.answer).toContain("both standalone and consolidated");
  });

  it("matches an expense metric against a half-year source header", () => {
    const classification = classifyNumericQuery(
      "Half year ended 30-Sep-2026 - Employee benefits expense",
    );
    expect(classification).toMatchObject({
      kind: "lookup",
      query: {
        metricLabel: "expenses",
        metricSearchTerms: ["expense", "cost"],
        columnSearchTerms: ["Half year ended 30-Sep-2026"],
        periods: ["H1"],
      },
    });
    if (classification.kind !== "lookup") throw new Error("Expected numeric lookup classification.");

    const currentHalf = fact("D17", "Employee benefits expense", "H1 FY2026-27", "292");
    const priorHalf = fact("E17", "Employee benefits expense", "H1 FY2025-26", "268.2");
    const result = resolveNumericLookup(classification.query, [
      {
        ...currentHalf,
        metadata: { ...currentHalf.metadata, column_header: "Half year ended 30-Sep-2026" },
      },
      {
        ...priorHalf,
        metadata: { ...priorHalf.metadata, column_header: "Half year ended 30-Sep-2025" },
      },
    ]);

    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") return;
    expect(result.records.map((record) => record.result_id)).toEqual(["D17"]);
    expect(result.answer).toContain("292 ₹ crore");
    expect(result.answer).toContain("H1 FY2026-27");
  });

  it("asks for a row when only a spreadsheet column header is requested", () => {
    const classification = classifyNumericQuery("Quarter ended 30-Sep-2026");
    expect(classification).toMatchObject({
      kind: "lookup",
      query: {
        metricLabel: "column Quarter ended 30-Sep-2026",
        metricSearchTerms: [],
        columnSearchTerms: ["Quarter ended 30-Sep-2026"],
      },
    });
    if (classification.kind !== "lookup") throw new Error("Expected column lookup classification.");

    const result = resolveNumericLookup(classification.query, [
      fact("B7", "I. Revenue from operations", "Q2 FY2026-27", "1245.6"),
      fact("B26", "IX. Profit for the period", "Q2 FY2026-27", "95.9"),
    ]);

    expect(result.kind).toBe("abstain");
    if (result.kind !== "abstain") return;
    expect(result.answer).toContain("I found the column");
    expect(result.answer).toContain("Which row or metric do you want?");
    expect(result.answer).toContain("Revenue from operations");
    expect(result.answer).toContain("Profit for the period");
  });

  it("resolves an explicit PAT attribution label and short fiscal-year notation", () => {
    const classification = classifyNumericQuery(
      "PAT attributable to equity shareholders - Q2 FY26",
    );
    expect(classification).toMatchObject({
      kind: "lookup",
      query: {
        metricLabel: "PAT attributable to equity shareholders",
        metricSearchTerms: ["PAT attributable to equity shareholders"],
        periods: ["Q2 FY2025-26"],
        fiscalYear: "FY2025-26",
      },
    });
    if (classification.kind !== "lookup") throw new Error("Expected numeric lookup classification.");

    const result = resolveNumericLookup(classification.query, [
      fact(
        "EPS-B5",
        "PAT attributable to equity shareholders (₹ crore)",
        "Q2 FY2025-26",
        "67.4",
        "",
      ),
      fact("EPS-B10", "PAT margin", "Q2 FY2025-26", "0.0608", ""),
      fact(
        "EPS-B11",
        "Consolidated PAT attributable to owners (₹ crore)",
        "Q2 FY2025-26",
        "72",
        "consolidated",
      ),
      fact("RESULTS-C26", "IX. Profit for the period", "Q2 FY2025-26", "68.1"),
    ]);

    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") return;
    expect(result.records.map((record) => record.result_id)).toEqual(["EPS-B5"]);
    expect(result.answer).toContain("67.4 ₹ crore");
    expect(result.answer).toContain("Q2 FY2025-26");
  });

  it("returns the exact requested value and source-cell citation", () => {
    const classification = classifyNumericQuery("What was standalone revenue for Q2 FY2026-27?");
    if (classification.kind !== "lookup") throw new Error("Expected numeric lookup classification.");

    const result = resolveNumericLookup(classification.query, [
      fact("C7", "I. Revenue from operations", "Q2 FY2025-26", "1108.2"),
      revenueQ2,
    ]);

    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") return;
    expect(result.answer).toContain("1245.6 ₹ crore");
    expect(result.answer).not.toContain("1108.2");
    expect(exactFactCitations(result.records)[0].location).toEqual({
      sheet: "Results",
      row: 7,
      cell: "B7",
    });
  });

  it("abstains rather than choosing an unrequested period", () => {
    const classification = classifyNumericQuery("What was standalone revenue?");
    if (classification.kind !== "lookup") throw new Error("Expected numeric lookup classification.");

    const result = resolveNumericLookup(classification.query, [
      revenueQ2,
      fact("D7", "I. Revenue from operations", "H1 FY2026-27", "2430.8"),
    ]);

    expect(result.kind).toBe("abstain");
    expect(result.answer).toContain("multiple periods");
  });

  it("requires a precise profit metric when the source has multiple profit rows", () => {
    const classification = classifyNumericQuery("What was profit for Q2 FY2026-27?");
    if (classification.kind !== "lookup") throw new Error("Expected numeric lookup classification.");

    const result = resolveNumericLookup(classification.query, [
      fact("B10", "Profit before tax", "Q2 FY2026-27", "90"),
      fact("B11", "Profit for the period", "Q2 FY2026-27", "70"),
    ]);

    expect(result.kind).toBe("abstain");
    expect(result.answer).toContain("more than one matching metric");
  });

  it("answers explicit multi-period comparisons with all exact facts", () => {
    const classification = classifyNumericQuery(
      "Compare standalone revenue for Q2 and H1 FY2026-27",
    );
    if (classification.kind !== "lookup") throw new Error("Expected numeric lookup classification.");

    const result = resolveNumericLookup(classification.query, [
      revenueQ2,
      fact("D7", "I. Revenue from operations", "H1 FY2026-27", "2430.8"),
      fact("C7", "I. Revenue from operations", "Q2 FY2025-26", "1108.2"),
    ]);

    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") return;
    expect(result.records.map((record) => record.metadata?.period)).toEqual([
      "Q2 FY2026-27",
      "H1 FY2026-27",
    ]);
    expect(result.answer).toContain("1245.6 ₹ crore [S1]");
    expect(result.answer).toContain("2430.8 ₹ crore [S2]");
    expect(result.answer).not.toContain("1108.2");
  });

  it("matches balance-sheet as-at dates exactly", () => {
    const classification = classifyNumericQuery(
      "What was property, plant and equipment as at 31-Mar-2026?",
    );
    expect(classification.kind).toBe("lookup");
    if (classification.kind !== "lookup") return;
    const balanceSheetFact: RetrievedRecord = {
      ...fact("C7", "Property, plant and equipment", "As at 31-Mar-2026", "640"),
      source_location: { sheet: "Balance Sheet", row: 7, cell: "C7" },
      metadata: {
        row_label: "Property, plant and equipment",
        period: "As at 31-Mar-2026",
        column_header: "As at 31-Mar-2026",
        unit: "₹ crore",
        value_text: "640",
        numeric_value: 640,
      },
    };

    expect(classification.query.periods).toEqual(["As at 31-Mar-2026"]);
    expect(resolveNumericLookup(classification.query, [balanceSheetFact])).toMatchObject({
      kind: "answer",
      answer: expect.stringContaining("640 ₹ crore"),
    });
  });

  it("uses an exact as-at header for a long balance-sheet line-item query", () => {
    const classification = classifyNumericQuery(
      "Bank balances other than cash equivalents - As at 30-Sep-2026",
    );
    expect(classification).toMatchObject({
      kind: "lookup",
      query: {
        metricSearchTerms: ["bank", "balances", "other", "than", "cash", "equivalents"],
        columnSearchTerms: ["As at 30-Sep-2026"],
        periods: ["As at 30-Sep-2026"],
      },
    });
    if (classification.kind !== "lookup") throw new Error("Expected numeric lookup classification.");

    const bankBalances = {
      ...fact(
        "B18",
        "Bank balances other than cash equivalents",
        "As at 30-Sep-2026",
        "35",
      ),
      source_location: { sheet: "Balance Sheet", row: 18, cell: "B18" },
      metadata: {
        row_label: "Bank balances other than cash equivalents",
        column_header: "As at 30-Sep-2026",
        period: "Q2 FY2026-27",
        scope: null,
        unit: "₹ crore",
        value_text: "35",
        numeric_value: 35,
      },
    };

    expect(resolveNumericLookup(classification.query, [bankBalances])).toMatchObject({
      kind: "answer",
      answer: expect.stringContaining("35 ₹ crore"),
    });
  });

  it("searches hyphenated balance-sheet terms as separate row-label words", () => {
    const classification = classifyNumericQuery("Right-of-use assets - As at 31-Mar-2026");

    expect(classification).toMatchObject({
      kind: "lookup",
      query: {
        metricSearchTerms: ["right", "use", "assets"],
        columnSearchTerms: ["As at 31-Mar-2026"],
        periods: ["As at 31-Mar-2026"],
      },
    });
  });

  it("parses a physical row and column request into a direct cell lookup", () => {
    const classification = classifyNumericQuery("What value is at row 7, column 3?");

    expect(classification).toMatchObject({
      kind: "lookup",
      query: {
        rowNumber: 7,
        columnNumber: 3,
        metricSearchTerms: [],
      },
    });
    if (classification.kind !== "lookup") return;
    const cell: RetrievedRecord = {
      ...fact("C7", "I. Revenue from operations", "Q2 FY2025-26", "1108.2"),
      source_location: { sheet: "Standalone Results", row: 7, column: 3, cell: "C7" },
      metadata: {
        row_label: "I. Revenue from operations",
        column_header: "Quarter ended 30-Sep-2025",
        value_text: "1108.2",
        unit: "₹ crore",
      },
    };

    const result = resolveNumericLookup(classification.query, [cell]);
    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") return;
    expect(result.answer).toContain("Standalone Results!C7");
    expect(result.answer).toContain("column header: “Quarter ended 30-Sep-2025”");
    expect(result.answer).toContain("1108.2 ₹ crore");
  });

  it("asks the user to separate questions containing multiple metrics", () => {
    expect(classifyNumericQuery("Compare revenue and EBITDA for Q2 FY2026-27")).toEqual({
      kind: "clarify",
      message: "Please ask for one metric at a time so I can look up each value against its exact source cell.",
    });
  });

  it("keeps narrative board questions on the narrative retrieval path", () => {
    expect(classifyNumericQuery("What was the board decision?")).toEqual({
      kind: "not_numeric",
    });
    expect(classifyNumericQuery("What was the revenue trend?")).toEqual({
      kind: "not_numeric",
    });
  });

  it("clarifies when a value request does not name a metric", () => {
    expect(classifyNumericQuery("How much was reported?")).toMatchObject({
      kind: "clarify",
      message: "Which document metric or line item should I look up?",
    });
  });

  it("asks for reporting scope when a single-period metric has two scopes", () => {
    const classification = classifyNumericQuery("What was revenue for Q2 FY2026-27?");
    if (classification.kind !== "lookup") throw new Error("Expected numeric lookup classification.");

    const result = resolveNumericLookup(classification.query, [
      revenueQ2,
      fact("B7-consolidated", "I. Revenue from operations", "Q2 FY2026-27", "1378.4", "consolidated"),
    ]);

    expect(result.kind).toBe("abstain");
    expect(result.answer).toContain("both standalone and consolidated");
  });

  it("does not mistake explicit scope for an explicit fiscal year", () => {
    const classification = classifyNumericQuery(
      "What was revenue for Q2 in both standalone and consolidated results?",
    );
    if (classification.kind !== "lookup") throw new Error("Expected numeric lookup classification.");

    const result = resolveNumericLookup(classification.query, [
      revenueQ2,
      fact("B7-prior", "I. Revenue from operations", "Q2 FY2025-26", "1108.2"),
      fact("B7-consolidated", "I. Revenue from operations", "Q2 FY2026-27", "1378.4", "consolidated"),
      fact("B7-consolidated-prior", "I. Revenue from operations", "Q2 FY2025-26", "1216.7", "consolidated"),
    ]);

    expect(result.kind).toBe("abstain");
    expect(result.answer).toContain("multiple periods");
  });

  it("inherits the metric and fiscal year for a period-only follow-up", () => {
    expect(classifyNumericFollowUp(
      "What about H1?",
      "What was standalone revenue for Q2 FY2026-27?",
    )).toMatchObject({
      kind: "lookup",
      query: {
        metricLabel: "revenue",
        periods: ["H1 FY2026-27"],
        fiscalYear: "FY2026-27",
        scope: "standalone",
      },
    });
  });
});
