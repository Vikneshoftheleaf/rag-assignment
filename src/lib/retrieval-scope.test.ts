import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock, embedTextsMock, rpcMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  embedTextsMock: vi.fn(),
  rpcMock: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

vi.mock("@/lib/providers", () => ({
  ProviderError: class ProviderError extends Error {
    constructor(message: string, readonly retryable: boolean) {
      super(message);
    }
  },
  embedTexts: embedTextsMock,
}));

import {
  buildRetrievalQueries,
  lookupStructuredFacts,
  prepareFeedbackRetrieval,
  retrieveEvidence,
} from "./retrieval";
import { ProviderError } from "@/lib/providers";
import { classifyNumericQuery } from "./numeric-lookup";

describe("query expansion", () => {
  it("retrieves each requested financial metric and reporting period", () => {
    expect(buildRetrievalQueries(
      "What revenue and profit were reported for Q2 and H1 FY2026-27?",
    )).toEqual([
      "What revenue and profit were reported for Q2 and H1 FY2026-27?",
      "revenue from operations Q2 FY2026-27",
      "revenue from operations H1 FY2026-27",
      "profit for the period Q2 FY2026-27",
      "profit for the period H1 FY2026-27",
    ]);
  });

  it("adds focused conclusion searches for auditor questions", () => {
    expect(buildRetrievalQueries("What did the auditor conclude about financial results?"))
      .toEqual([
        "What did the auditor conclude about financial results?",
        "auditor limited review conclusion",
        "nothing has come to our attention material misstatement",
      ]);
  });

  it("searches specific board dividend follow-ups and implementation authorisations", () => {
    const queries = buildRetrievalQueries(
      "What decisions and follow-up actions were recorded in the 22 October 2026 board meeting?",
    );

    expect(queries).toContain(
      "interim dividend follow-up verify final entitlement data tax payment arrangements disclosures",
    );
    expect(queries).toContain(
      "interim dividend resolution BR-02 processing payment compliance filing action owner",
    );
    expect(queries).toContain(
      "Q2 H1 results BR-01 CFO Finance Company Secretary limited review exchange disclosure filing action",
    );
    expect(queries).toContain(
      "general authorisation filings implementation limits board decision",
    );
  });
});

describe("document-scoped retrieval", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
    embedTextsMock.mockResolvedValue([[0.1, 0.2]]);
    rpcMock.mockResolvedValue({ data: [], error: null });
    createClientMock.mockReturnValue({ rpc: rpcMock });
  });

  it("uses the document search RPC and passes the selected document id", async () => {
    await retrieveEvidence("Summarize the board minutes.", "document-uuid");

    expect(rpcMock).toHaveBeenCalledWith("document_hybrid_search", {
      query_embedding: "[0.1,0.2]",
      query_text: "Summarize the board minutes.",
      match_count: 50,
      target_document_id: "document-uuid",
    });
  });

  it("retrieves a sheet overview by its exact workbook sheet name", async () => {
    const classification = classifyNumericQuery("balance sheet");
    if (classification.kind !== "lookup") throw new Error("Expected sheet lookup classification.");

    await lookupStructuredFacts(classification.query);

    expect(rpcMock).toHaveBeenCalledWith("lookup_workbook_cells", expect.objectContaining({
      p_row_terms: [],
      p_column_terms: [],
      p_sheet_name: "Balance Sheet",
      p_target_document_id: null,
    }));
  });

  it("requests a larger corpus-wide candidate set for better structured-fact recall", async () => {
    await retrieveEvidence("What decision was recorded?");

    expect(rpcMock).toHaveBeenCalledWith("hybrid_search", {
      query_embedding: "[0.1,0.2]",
      query_text: "What decision was recorded?",
      match_count: 50,
    });
  });

  it("sends the exact requested workbook row and normalized fiscal period to lookup", async () => {
    const classification = classifyNumericQuery(
      "PAT attributable to equity shareholders - Q2 FY26",
    );
    if (classification.kind !== "lookup") throw new Error("Expected numeric lookup classification.");

    await lookupStructuredFacts(classification.query);

    expect(rpcMock).toHaveBeenCalledWith("lookup_workbook_cells", expect.objectContaining({
      p_row_terms: ["PAT attributable to equity shareholders"],
      p_period: "Q2 FY2025-26",
      p_scope: null,
      p_target_document_id: null,
    }));
  });

  it("uses the requested spreadsheet column header when no fiscal shorthand is given", async () => {
    const classification = classifyNumericQuery(
      "Revenue from operations - Quarter ended 30-Sep-2026",
    );
    if (classification.kind !== "lookup") throw new Error("Expected numeric lookup classification.");

    await lookupStructuredFacts(classification.query);

    expect(rpcMock).toHaveBeenCalledWith("lookup_workbook_cells", expect.objectContaining({
      p_row_terms: ["revenue", "turnover", "sales"],
      p_column_terms: ["Quarter ended 30-Sep-2026"],
      p_period: null,
      p_scope: null,
      p_target_document_id: null,
    }));
  });

  it("uses an exact as-at column header rather than period metadata for dated line-item lookup", async () => {
    const classification = classifyNumericQuery(
      "Bank balances other than cash equivalents - As at 30-Sep-2026",
    );
    if (classification.kind !== "lookup") throw new Error("Expected numeric lookup classification.");

    await lookupStructuredFacts(classification.query);

    expect(rpcMock).toHaveBeenCalledWith("lookup_workbook_cells", expect.objectContaining({
      p_row_terms: ["bank", "balances", "other", "than", "cash", "equivalents"],
      p_column_terms: ["As at 30-Sep-2026"],
      p_period: null,
      p_sheet_name: null,
    }));
  });

  it("does not narrow an exact half-year column header to the derived H1 period", async () => {
    const classification = classifyNumericQuery(
      "Half year ended 30-Sep-2026 - Employee benefits expense",
    );
    if (classification.kind !== "lookup") throw new Error("Expected numeric lookup classification.");

    await lookupStructuredFacts(classification.query);

    expect(rpcMock).toHaveBeenCalledWith("lookup_workbook_cells", expect.objectContaining({
      p_row_terms: ["expense", "cost"],
      p_column_terms: ["Half year ended 30-Sep-2026"],
      p_period: null,
      p_scope: null,
    }));
  });

  it("looks up the exact column when the question contains only a period header", async () => {
    const classification = classifyNumericQuery("Quarter ended 30-Sep-2026");
    if (classification.kind !== "lookup") throw new Error("Expected column lookup classification.");

    await lookupStructuredFacts(classification.query);

    expect(rpcMock).toHaveBeenCalledWith("lookup_workbook_cells", expect.objectContaining({
      p_row_terms: [],
      p_column_terms: ["Quarter ended 30-Sep-2026"],
      p_period: null,
      p_target_document_id: null,
    }));
  });

  it("fuses ranks across hybrid query variants before lexical reranking", async () => {
    const makeRecord = (id: string, content: string, score: number) => ({
      result_id: id,
      result_kind: "chunk",
      content,
      source_filename: "minutes.docx",
      source_type: "docx",
      source_location: {},
      metadata: {},
      score,
    });
    const singleQueryHit = makeRecord(
      "single-query-hit",
      "Board decision recorded for the meeting agenda item.",
      0.9,
    );
    const multiQueryHit = makeRecord(
      "multi-query-hit",
      "Board decision follow-up action for agenda item.",
      0.3,
    );
    const queries = buildRetrievalQueries(
      "What board decisions and follow-up actions were recorded in the meeting?",
    );
    embedTextsMock.mockImplementation(async (texts: string[]) =>
      texts.map((_, index) => [index + 0.1]),
    );
    rpcMock.mockImplementation(async (_functionName: string, args: { query_text: string }) => ({
      data: args.query_text === queries[0]
        ? [singleQueryHit, multiQueryHit]
        : args.query_text === queries[1] || args.query_text === queries[2]
          ? [multiQueryHit]
          : [],
      error: null,
    }));

    const results = await retrieveEvidence(queries[0]);

    expect(results[0].result_id).toBe("multi-query-hit");
    expect(results[0].retrieval_score).toBeGreaterThan(results[1].retrieval_score || 0);
    expect(rpcMock).toHaveBeenCalledTimes(queries.length);
  });

  it("returns all database candidates without an application-side result cap", async () => {
    const records = Array.from({ length: 125 }, (_, index) => ({
      result_id: `candidate-${index + 1}`,
      result_kind: "chunk",
      content: `Source excerpt ${index + 1}`,
      source_filename: "minutes.docx",
      source_type: "docx",
      source_location: {},
      metadata: {},
      score: index === 124 ? 0.01 : 0.8,
    }));
    rpcMock.mockResolvedValue({ data: records, error: null });

    const results = await retrieveEvidence("Summarize these minutes.");

    expect(results).toHaveLength(records.length);
    expect(results.some((record) => record.result_id === "candidate-125")).toBe(true);
  });

  it("reranks close hybrid candidates using exact workbook and source terms", async () => {
    const genericHit = {
      result_id: "generic-hit",
      result_kind: "chunk",
      content: "The board reviewed several operational topics.",
      source_filename: "minutes.docx",
      source_type: "docx",
      source_location: {},
      metadata: {},
      score: 0.81,
    };
    const exactHit = {
      result_id: "exact-hit",
      result_kind: "chunk",
      content: "Cybersecurity mitigation action: implement multi-factor authentication.",
      source_filename: "register.xlsx",
      source_type: "xlsx",
      source_location: { sheet: "Risk Register", row: 8, cell: "C8" },
      metadata: {
        sheet_name: "Risk Register",
        row_label: "Cybersecurity mitigation action",
        column_header: "Control owner",
      },
      score: 0.8,
    };
    rpcMock.mockResolvedValue({ data: [genericHit, exactHit], error: null });

    const results = await retrieveEvidence("What cybersecurity mitigation action?");

    expect(results.map((record) => record.result_id)).toEqual(["exact-hit", "generic-hit"]);
    expect(results[0].retrieval_score).toBeGreaterThan(results[1].retrieval_score || 0);
  });

  it("searches only the authenticated user's feedback context before normal retrieval", async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{
        positive_source_ids: ["positive-source"],
        negative_source_ids: ["negative-source"],
      }],
      error: null,
    });

    const context = await prepareFeedbackRetrieval(
      "What is the approved decision?",
      "user-uuid",
      "a".repeat(64),
    );

    expect(rpcMock).toHaveBeenCalledWith("match_turn_feedback_sources", {
      p_query_embedding: "[0.1,0.2]",
      p_user_id: "user-uuid",
      p_corpus_revision: "a".repeat(64),
      p_document_id: null,
      p_min_similarity: 0.78,
    });
    expect(context.hasMatches).toBe(true);
    expect(context.positiveSourceIds.has("positive-source")).toBe(true);
    expect(context.negativeSourceIds.has("negative-source")).toBe(true);
  });

  it("continues without feedback retrieval when embedding is rate limited", async () => {
    embedTextsMock.mockRejectedValue(new ProviderError("HTTP 429", true));

    const context = await prepareFeedbackRetrieval(
      "What is the approved decision?",
      "user-uuid",
      "a".repeat(64),
    );

    expect(context).toEqual({
      queryEmbedding: null,
      positiveSourceIds: new Set(),
      negativeSourceIds: new Set(),
      hasMatches: false,
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("uses text retrieval when embeddings are unavailable", async () => {
    embedTextsMock.mockRejectedValue(new ProviderError("HTTP 429", true));

    await retrieveEvidence("Summarize the board minutes.");

    expect(rpcMock).toHaveBeenCalledWith("hybrid_search", expect.objectContaining({
      query_embedding: null,
      query_text: "Summarize the board minutes.",
    }));
  });

  it("does not retry embeddings after feedback preparation was rate limited", async () => {
    embedTextsMock.mockRejectedValue(new ProviderError("HTTP 429", true));
    const context = await prepareFeedbackRetrieval(
      "Summarize the board minutes.",
      "user-uuid",
      "a".repeat(64),
    );
    embedTextsMock.mockClear();

    await retrieveEvidence("Summarize the board minutes.", undefined, context);

    expect(embedTextsMock).not.toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalledWith("hybrid_search", expect.objectContaining({
      query_embedding: null,
    }));
  });

  it("boosts positively rated evidence and demotes negatively rated evidence", async () => {
    const record = (id: string) => ({
      result_id: id,
      result_kind: "chunk",
      content: "An approved decision.",
      source_filename: "minutes.docx",
      source_type: "docx",
      source_location: {},
      metadata: {},
      score: 0.8,
    });
    embedTextsMock.mockResolvedValue([]);
    rpcMock.mockResolvedValue({
      data: [record("positive-source"), record("negative-source")],
      error: null,
    });

    const results = await retrieveEvidence("What decision was approved?", undefined, {
      queryEmbedding: [0.1, 0.2],
      positiveSourceIds: new Set(["positive-source"]),
      negativeSourceIds: new Set(["negative-source"]),
      hasMatches: true,
    });

    const positive = results.find((item) => item.result_id === "positive-source");
    const negative = results.find((item) => item.result_id === "negative-source");
    expect(positive?.score).toBeGreaterThan(negative?.score || 0);
    expect(positive?.retrieval_score).toBeGreaterThan(0);
  });
});
