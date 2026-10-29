import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Citation } from "@/lib/types";

const {
  buildCacheConfigurationHash,
  buildGroundedPrompt,
  buildTransformPrompt,
  buildQuestionKey,
  formatCitations,
  generateStreamWithFallback,
  generateWithFallback,
  getCorpusRevision,
  getSupabase,
  keepCitedSources,
  lookupStructuredFacts,
  readCachedResponse,
  retrieveEvidence,
  prepareFeedbackRetrieval,
  writeCachedResponse,
  getFeedbackStats,
  getRetrievalMatchPercent,
  recordTurnFeedback,
  toFeedbackSources,
  applyQueryPolicy,
  getRequestUser,
} = vi.hoisted(() => ({
  buildCacheConfigurationHash: vi.fn(() => "configuration"),
  buildGroundedPrompt: vi.fn((question: string, records: Array<{ result_kind: string }>) =>
    question ? records.slice(0, 0) : []),
  buildTransformPrompt: vi.fn(() => []),
  buildQuestionKey: vi.fn(() => "question"),
  formatCitations: vi.fn((_records: unknown[]): Citation[] => []),
  generateStreamWithFallback: vi.fn(),
  generateWithFallback: vi.fn(),
  getCorpusRevision: vi.fn(),
  getSupabase: vi.fn(),
  keepCitedSources: vi.fn(),
  lookupStructuredFacts: vi.fn(),
  readCachedResponse: vi.fn(),
  retrieveEvidence: vi.fn(),
  prepareFeedbackRetrieval: vi.fn(),
  writeCachedResponse: vi.fn(),
  getFeedbackStats: vi.fn(),
  getRetrievalMatchPercent: vi.fn(),
  recordTurnFeedback: vi.fn(),
  toFeedbackSources: vi.fn(),
  applyQueryPolicy: vi.fn(),
  getRequestUser: vi.fn(),
}));

vi.mock("@/lib/chat-cache", () => ({
  buildCacheConfigurationHash,
  buildQuestionKey,
  getCorpusRevision,
  readCachedResponse,
  writeCachedResponse,
}));

vi.mock("@/lib/providers", () => ({
  generateStreamWithFallback,
  generateWithFallback,
}));

vi.mock("@/lib/retrieval", () => ({
  formatCitations,
  getSupabase,
  keepCitedSources,
  retrieveEvidence,
  lookupStructuredFacts,
  prepareFeedbackRetrieval,
}));
vi.mock("@/lib/turn-feedback", () => ({
  getFeedbackStats,
  getRetrievalMatchPercent,
  recordTurnFeedback,
  toFeedbackSources,
}));

vi.mock("@/lib/prompt", () => ({ buildGroundedPrompt, buildTransformPrompt }));
vi.mock("@/lib/query-policy", () => ({ applyQueryPolicy }));
vi.mock("@/lib/supabase-auth", () => ({ getRequestUser }));

import { POST } from "./route";

function makeHistorySupabase(sessionId: string, turn: {
  id: string;
  question: string;
  answer: string;
  citations: unknown[];
  abstained: boolean;
}) {
  const sessionQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { id: sessionId }, error: null }),
  };
  sessionQuery.select.mockReturnValue(sessionQuery);
  sessionQuery.eq.mockReturnValue(sessionQuery);

  const turnQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    neq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn().mockResolvedValue({ data: [turn], error: null }),
  };
  turnQuery.select.mockReturnValue(turnQuery);
  turnQuery.eq.mockReturnValue(turnQuery);
  turnQuery.neq.mockReturnValue(turnQuery);
  turnQuery.order.mockReturnValue(turnQuery);

  const feedbackQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn().mockResolvedValue({ data: [], error: null }),
  };
  feedbackQuery.select.mockReturnValue(feedbackQuery);
  feedbackQuery.eq.mockReturnValue(feedbackQuery);

  return {
    from: vi.fn((table: string) => table === "chat_sessions"
      ? sessionQuery
      : table === "chat_turns"
        ? turnQuery
        : feedbackQuery),
  };
}

describe("POST /api/chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSupabase.mockReturnValue({});
    getCorpusRevision.mockResolvedValue("corpus-revision");
    prepareFeedbackRetrieval.mockResolvedValue({
      queryEmbedding: [0.1, 0.2],
      positiveSourceIds: new Set(),
      negativeSourceIds: new Set(),
      hasMatches: false,
    });
    readCachedResponse.mockResolvedValue(null);
    retrieveEvidence.mockResolvedValue([{
      score: 0.9,
      source_filename: "minutes.docx",
    }]);
    lookupStructuredFacts.mockResolvedValue([{
      result_id: "fact-id",
      result_kind: "fact",
      content: "Revenue from operations: 1245.6 ₹ crore (Q2 FY2026-27) [standalone]",
      source_filename: "results.xlsx",
      source_type: "xlsx",
      source_location: { sheet: "Standalone Results", row: 7, cell: "B7" },
      metadata: {
        row_label: "I. Revenue from operations",
        period: "Q2 FY2026-27",
        scope: "standalone",
        unit: "₹ crore",
        value_text: "1245.6",
      },
      score: 1,
    }]);
    formatCitations.mockReturnValue([]);
    keepCitedSources.mockImplementation((answer) => ({ answer, citations: [] }));
    writeCachedResponse.mockResolvedValue(undefined);
    recordTurnFeedback.mockResolvedValue("feedback-id");
    getFeedbackStats.mockResolvedValue({
      positiveCount: 0,
      negativeCount: 0,
      approvalPercent: null,
    });
    getRetrievalMatchPercent.mockReturnValue(90);
    toFeedbackSources.mockReturnValue([]);
    generateWithFallback.mockResolvedValue({
      text: "Generated answer [S1].",
      provider: "cloudflare-primary",
    });
    applyQueryPolicy.mockReturnValue({ allowed: true });
    getRequestUser.mockResolvedValue({ id: "user-1" });
    generateStreamWithFallback.mockImplementation(async function* () {
      yield { text: "Summary text.", provider: "cloudflare-primary" };
    });
  });

  it("rejects requests without an authenticated user", async () => {
    getRequestUser.mockResolvedValue(null);
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "What decisions were approved?" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(retrieveEvidence).not.toHaveBeenCalled();
  });

  it("sends exact workbook facts to the LLM for numeric answers", async () => {
    toFeedbackSources.mockReturnValue([{
      sourceId: "fact-id",
      kind: "fact",
      content: "Revenue from operations: 1245.6 ₹ crore",
      filename: "results.xlsx",
      location: { sheet: "Standalone Results", row: 7, cell: "B7" },
      score: 1,
    }]);
    generateWithFallback.mockResolvedValue({
      text: "Revenue from operations was 1245.6 ₹ crore [S1].",
      provider: "cloudflare-primary",
    });
    formatCitations.mockReturnValue([{
      id: "S1",
      sourceId: "fact-id",
      filename: "results.xlsx",
      documentType: "xlsx",
      location: { sheet: "Standalone Results", row: 7, cell: "B7" },
      excerpt: "Revenue from operations: 1245.6 ₹ crore",
      kind: "fact",
      score: 1,
    }]);
    keepCitedSources.mockImplementation((answer, citations) => ({ answer, citations }));
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "What was standalone revenue for Q2 FY2026-27?" }),
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.answer).toContain("1245.6 ₹ crore");
    expect(payload.citations).toEqual([expect.objectContaining({
      sourceId: "fact-id",
      location: { sheet: "Standalone Results", row: 7, cell: "B7" },
    })]);
    expect(payload.retrievalMatchPercent).toBe(90);
    expect(lookupStructuredFacts).toHaveBeenCalledOnce();
    expect(retrieveEvidence).not.toHaveBeenCalled();
    expect(buildGroundedPrompt).toHaveBeenCalledWith(
      "What was standalone revenue for Q2 FY2026-27?",
      expect.arrayContaining([expect.objectContaining({
        content: "Revenue from operations: 1245.6 ₹ crore (Q2 FY2026-27) [standalone]",
      })]),
      [],
    );
    expect(generateWithFallback).toHaveBeenCalledOnce();
    expect(recordTurnFeedback).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sources: [expect.objectContaining({ sourceId: "fact-id", kind: "fact" })],
    }));
  });

  it("routes an explicit quarter-ended workbook header to exact numeric lookup", async () => {
    lookupStructuredFacts.mockResolvedValue([
      {
        result_id: "standalone-revenue",
        result_kind: "fact",
        content: "I. Revenue from operations | Quarter ended 30-Sep-2026: 1245.6",
        source_filename: "results.xlsx",
        source_type: "xlsx",
        source_location: { sheet: "Standalone Results", row: 7, cell: "B7" },
        metadata: {
          row_label: "I. Revenue from operations",
          column_header: "Quarter ended 30-Sep-2026",
          period: "Q2 FY2026-27",
          scope: "standalone",
          value_text: "1245.6",
          unit: "₹ crore",
        },
        score: 1,
      },
      {
        result_id: "consolidated-revenue",
        result_kind: "fact",
        content: "I. Revenue from operations | Quarter ended 30-Sep-2026: 1378.4",
        source_filename: "results.xlsx",
        source_type: "xlsx",
        source_location: { sheet: "Consolidated Results", row: 7, cell: "B7" },
        metadata: {
          row_label: "I. Revenue from operations",
          column_header: "Quarter ended 30-Sep-2026",
          period: "Q2 FY2026-27",
          scope: "consolidated",
          value_text: "1378.4",
          unit: "₹ crore",
        },
        score: 1,
      },
    ]);
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Revenue from operations - Quarter ended 30-Sep-2026",
      }),
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.abstained).toBe(false);
    expect(lookupStructuredFacts).toHaveBeenCalledOnce();
    expect(lookupStructuredFacts).toHaveBeenCalledWith(expect.objectContaining({
      metricSearchTerms: ["revenue", "turnover", "sales"],
      columnSearchTerms: ["Quarter ended 30-Sep-2026"],
      scope: null,
    }), undefined);
    expect(buildGroundedPrompt).toHaveBeenCalledWith(
      "Revenue from operations - Quarter ended 30-Sep-2026",
      expect.arrayContaining([
        expect.objectContaining({ result_id: "standalone-revenue" }),
        expect.objectContaining({ result_id: "consolidated-revenue" }),
      ]),
      [],
    );
    expect(retrieveEvidence).not.toHaveBeenCalled();
    expect(generateWithFallback).toHaveBeenCalledOnce();
  });

  it("routes a bare balance-sheet request to a sheet-scoped grounded overview", async () => {
    const balanceSheetCell = {
      result_id: "balance-sheet-cash",
      result_kind: "fact",
      content: "Cash and cash equivalents | As at 30-Sep-2026: 92",
      source_filename: "results.xlsx",
      source_type: "xlsx",
      source_location: { sheet: "Balance Sheet", row: 7, cell: "B7" },
      metadata: {
        row_label: "Cash and cash equivalents",
        column_header: "As at 30-Sep-2026",
        value_text: "92",
        unit: "₹ crore",
      },
      score: 1,
    };
    lookupStructuredFacts.mockResolvedValue([balanceSheetCell]);
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "balance sheet" }),
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.abstained).toBe(false);
    expect(lookupStructuredFacts).toHaveBeenCalledWith(expect.objectContaining({
      sheetName: "Balance Sheet",
      metricSearchTerms: [],
    }), undefined);
    expect(buildGroundedPrompt).toHaveBeenCalledWith(
      "Summarize the Balance Sheet worksheet.",
      [balanceSheetCell],
      [],
    );
    expect(retrieveEvidence).not.toHaveBeenCalled();
  });

  it("uses exact structured lookup for a dated long balance-sheet line item", async () => {
    const bankBalancesCell = {
      result_id: "bank-balances-b18",
      result_kind: "fact",
      content: "Bank balances other than cash equivalents | As at 30-Sep-2026: 35",
      source_filename: "results.xlsx",
      source_type: "xlsx",
      source_location: { sheet: "Balance Sheet", row: 18, cell: "B18" },
      metadata: {
        row_label: "Bank balances other than cash equivalents",
        column_header: "As at 30-Sep-2026",
        period: "As at 30-Sep-2026",
        value_text: "35",
        unit: "₹ crore",
      },
      score: 1,
    };
    lookupStructuredFacts.mockResolvedValue([bankBalancesCell]);
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Bank balances other than cash equivalents - As at 30-Sep-2026",
      }),
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.abstained).toBe(false);
    expect(lookupStructuredFacts).toHaveBeenCalledWith(expect.objectContaining({
      metricSearchTerms: ["bank", "balances", "other", "than", "cash", "equivalents"],
      columnSearchTerms: ["As at 30-Sep-2026"],
    }), undefined);
    expect(buildGroundedPrompt).toHaveBeenCalledWith(
      "Bank balances other than cash equivalents - As at 30-Sep-2026",
      [bankBalancesCell],
      [],
    );
    expect(retrieveEvidence).not.toHaveBeenCalled();
  });

  it("passes all retrieved candidates to the model regardless of retrieval score", async () => {
    const candidates = [
      {
        result_id: "weak-score-candidate",
        result_kind: "chunk",
        content: "Relevant-looking source excerpt",
        source_filename: "minutes.docx",
        source_type: "docx",
        source_location: {},
        metadata: {},
        score: 0.01,
      },
      {
        result_id: "lowest-score-candidate",
        result_kind: "chunk",
        content: "Another retrieved source excerpt",
        source_filename: "minutes.docx",
        source_type: "docx",
        source_location: {},
        metadata: {},
        score: 0,
      },
    ];
    retrieveEvidence.mockResolvedValue(candidates);
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "What do these meeting notes say?" }),
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.abstained).toBe(false);
    expect(buildGroundedPrompt).toHaveBeenCalledWith(
      "What do these meeting notes say?",
      candidates,
      [],
    );
  });

  it("sends every matching cell to the LLM for a header-only query", async () => {
    const matchingCells = Array.from({ length: 52 }, (_, index) => ({
      result_id: `cell-${index + 1}`,
      result_kind: "fact" as const,
      content: `Metric ${index + 1} | Quarter ended 30-Sep-2026: ${index + 1}`,
      source_filename: "results.xlsx",
      source_type: "xlsx" as const,
      source_location: {
        sheet: "Standalone Results",
        row: index + 1,
        cell: `B${index + 1}`,
      },
      metadata: { row_label: `Metric ${index + 1}` },
      score: 1,
    }));
    lookupStructuredFacts.mockResolvedValue(matchingCells);
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Quarter ended 30-Sep-2026" }),
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.abstained).toBe(false);
    expect(lookupStructuredFacts).toHaveBeenCalledOnce();
    expect(buildGroundedPrompt).toHaveBeenCalledWith("Quarter ended 30-Sep-2026", matchingCells, []);
    expect(retrieveEvidence).not.toHaveBeenCalled();
    expect(generateWithFallback).toHaveBeenCalledOnce();
  });

  it("retrieves only the selected document when streaming a document summary", async () => {
    const documentId = "123e4567-e89b-42d3-a456-426614174000";
    const turnId = "123e4567-e89b-42d3-a456-426614174001";
    const message = "Summarize the key information in minutes.docx.";
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ message, documentId, turnId }),
    });

    const response = await POST(request);
    const stream = await response.text();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(retrieveEvidence).toHaveBeenCalledWith(
      message,
      documentId,
      expect.objectContaining({ queryEmbedding: [0.1, 0.2] }),
    );
    expect(buildQuestionKey).toHaveBeenCalledWith(`${message}\ndocument:${documentId}\nsearch`);
    expect(stream).toContain('event: token\ndata: {"text":"Summary text."}');
    expect(stream).toContain('"answer":"Summary text."');
    expect(stream).toContain('"intent":"search"');
    expect(stream).toContain(`"feedbackId":"${turnId}"`);
    expect(stream).toContain('"retrievalMatchPercent":90');
    expect(recordTurnFeedback).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      turnId,
      userId: "user-1",
      question: message,
      queryEmbedding: [0.1, 0.2],
    }));
  });

  it("answers explicit numeric comparisons with all exact requested facts", async () => {
    const records = [
      ["q2-standalone", "Q2 FY2026-27", "standalone", "1245.6"],
      ["q2-consolidated", "Q2 FY2026-27", "consolidated", "1378.4"],
      ["h1-standalone", "H1 FY2026-27", "standalone", "2430.8"],
      ["h1-consolidated", "H1 FY2026-27", "consolidated", "2690.5"],
    ].map(([id, period, scope, value]) => ({
      result_id: id,
      result_kind: "fact",
      content: `Revenue from operations: ${value} ₹ crore (${period}) [${scope}]`,
      source_filename: "results.xlsx",
      source_type: "xlsx",
      source_location: { sheet: "Results", row: 7, cell: id },
      metadata: {
        row_label: "Revenue from operations",
        period,
        scope,
        unit: "₹ crore",
        value_text: value,
      },
      score: 1,
    }));
    lookupStructuredFacts.mockResolvedValue(records);
    const message = "Compare Q2 and H1 revenue for standalone and consolidated results.";
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ message }),
    });

    const response = await POST(request);
    const stream = await response.text();

    expect(lookupStructuredFacts).toHaveBeenCalledOnce();
    expect(retrieveEvidence).not.toHaveBeenCalled();
    expect(generateWithFallback).not.toHaveBeenCalled();
    expect(buildGroundedPrompt).toHaveBeenCalledWith(
      message,
      records,
      [],
    );
    expect(stream).toContain("Summary text.");
  });

  it("bypasses cached answers when rated feedback matches the new query", async () => {
    prepareFeedbackRetrieval.mockResolvedValue({
      queryEmbedding: [0.1, 0.2],
      positiveSourceIds: new Set(["helpful-source"]),
      negativeSourceIds: new Set(),
      hasMatches: true,
    });
    readCachedResponse.mockResolvedValue({
      answer: "Old cached answer.",
      citations: [],
      abstained: false,
    });
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ message: "What decision was approved?" }),
    });

    const response = await POST(request);
    await response.text();

    expect(readCachedResponse).not.toHaveBeenCalled();
    expect(retrieveEvidence).toHaveBeenCalledWith(
      "What decision was approved?",
      undefined,
      expect.objectContaining({ positiveSourceIds: expect.any(Set) }),
    );
  });

  it("reformats the last stored answer without running document retrieval", async () => {
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const turnId = "123e4567-e89b-42d3-a456-426614174001";
    const previousAnswer = "Revenue was ₹1,245.6 crore. [S1]";
    getSupabase.mockReturnValue(makeHistorySupabase(sessionId, {
      id: "123e4567-e89b-42d3-a456-426614174002",
      question: "What revenue was reported?",
      answer: previousAnswer,
      citations: [],
      abstained: false,
    }));
    const message = "Put the last response in bullet points.";
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ message, turnId, sessionId }),
    });

    const response = await POST(request);
    const stream = await response.text();

    expect(buildTransformPrompt).toHaveBeenCalledWith(message, previousAnswer);
    expect(retrieveEvidence).not.toHaveBeenCalled();
    expect(stream).toContain('"answer":"Summary text."');
    expect(stream).toContain('"intent":"transform"');
    expect(stream).not.toContain('"feedbackId"');
    expect(recordTurnFeedback).not.toHaveBeenCalled();
  });

  it("uses stored conversation questions to resolve a follow-up search", async () => {
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const turnId = "123e4567-e89b-42d3-a456-426614174001";
    getSupabase.mockReturnValue(makeHistorySupabase(sessionId, {
      id: "123e4567-e89b-42d3-a456-426614174002",
      question: "What revenue was reported for Q2?",
      answer: "Standalone revenue was ₹1,245.6 crore. [S1]",
      citations: [],
      abstained: false,
    }));
    lookupStructuredFacts.mockResolvedValue([
      {
        result_id: "revenue-q2",
        result_kind: "fact",
        content: "Revenue from operations: 1245.6 ₹ crore (Q2 FY2026-27) [standalone]",
        source_filename: "results.xlsx",
        source_type: "xlsx",
        source_location: { sheet: "Standalone Results", row: 7, cell: "B7" },
        metadata: {
          row_label: "Revenue from operations",
          period: "Q2 FY2026-27",
          scope: "standalone",
          unit: "₹ crore",
          value_text: "1245.6",
        },
        score: 1,
      },
      {
        result_id: "revenue-h1",
        result_kind: "fact",
        content: "Revenue from operations: 2430.8 ₹ crore (H1 FY2026-27) [standalone]",
        source_filename: "results.xlsx",
        source_type: "xlsx",
        source_location: { sheet: "Standalone Results", row: 7, cell: "D7" },
        metadata: {
          row_label: "Revenue from operations",
          period: "H1 FY2026-27",
          scope: "standalone",
          unit: "₹ crore",
          value_text: "2430.8",
        },
        score: 1,
      },
    ]);
    const message = "What about H1?";
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ message, turnId, sessionId }),
    });

    const stream = await (await POST(request)).text();

    expect(prepareFeedbackRetrieval).toHaveBeenCalledWith(
      "What revenue was reported for Q2?\nWhat about H1?",
      "user-1",
      "corpus-revision",
      undefined,
    );
    expect(lookupStructuredFacts).toHaveBeenCalledWith(expect.objectContaining({
      periods: ["H1"],
      metricLabel: "revenue",
      scope: null,
    }), undefined);
    expect(stream).toContain("Summary text.");
    expect(retrieveEvidence).not.toHaveBeenCalled();
    expect(buildGroundedPrompt).toHaveBeenCalledWith(
      message,
      expect.arrayContaining([expect.objectContaining({ result_id: "revenue-h1" })]),
      expect.arrayContaining([expect.objectContaining({
        question: "What revenue was reported for Q2?",
      })]),
    );
  });

  it("returns the greeting redirect without retrieving evidence", async () => {
    applyQueryPolicy.mockReturnValue({ allowed: false, answer: "Use the document assistant." });
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ message: "Hello!" }),
    });

    const response = await POST(request);

    expect(await response.json()).toMatchObject({
      answer: "Use the document assistant.",
      citations: [],
      abstained: true,
    });
    expect(retrieveEvidence).not.toHaveBeenCalled();
  });
});