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
  embedTexts: embedTextsMock,
}));

import {
  buildRetrievalQueries,
  prepareFeedbackRetrieval,
  retrieveEvidence,
} from "./retrieval";

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

  it("requests a larger corpus-wide candidate set for better structured-fact recall", async () => {
    await retrieveEvidence("What decision was recorded?");

    expect(rpcMock).toHaveBeenCalledWith("hybrid_search", {
      query_embedding: "[0.1,0.2]",
      query_text: "What decision was recorded?",
      match_count: 50,
    });
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

    expect(results.find((item) => item.result_id === "positive-source")?.score).toBeCloseTo(0.92);
    expect(results.find((item) => item.result_id === "negative-source")?.score).toBeCloseTo(0.44);
  });
});
