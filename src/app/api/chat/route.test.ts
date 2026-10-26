import { beforeEach, describe, expect, it, vi } from "vitest";

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
  formatCitations: vi.fn(() => []),
  generateStreamWithFallback: vi.fn(),
  generateWithFallback: vi.fn(),
  getCorpusRevision: vi.fn(),
  getSupabase: vi.fn(),
  keepCitedSources: vi.fn(),
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

  it("prioritizes numeric facts and keeps a wider evidence set for financial questions", async () => {
    const records = Array.from({ length: 15 }, (_, index) => ({
      score: 0.9,
      result_id: `record-${index}`,
      result_kind: index < 4 ? "fact" : "chunk",
      metadata: index < 4 ? {
        row_label: "Revenue from operations",
        period: index < 2 ? "Q2 FY2026-27" : "H1 FY2026-27",
        scope: index % 2 === 0 ? "standalone" : "consolidated",
      } : {},
      content: index < 4 ? "Revenue from operations: 100" : "Relevant board decision.",
    }));
    retrieveEvidence.mockResolvedValue(records);
    const message = "Compare Q2 and H1 revenue for standalone and consolidated results.";
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ message }),
    });

    const response = await POST(request);
    await response.text();

    const selected = buildGroundedPrompt.mock.calls[0][1];
    expect(selected).toHaveLength(15);
    expect(selected.slice(0, 4).every((record) => record.result_kind === "fact")).toBe(true);
    expect(selected.slice(4).every((record) => record.result_kind === "chunk")).toBe(true);
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
    const message = "What about H1?";
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ message, turnId, sessionId }),
    });

    await (await POST(request)).text();

    expect(prepareFeedbackRetrieval).toHaveBeenCalledWith(
      "What revenue was reported for Q2?\nWhat about H1?",
      "user-1",
      "corpus-revision",
      undefined,
    );
    expect(retrieveEvidence).toHaveBeenCalledWith(
      "What revenue was reported for Q2?\nWhat about H1?",
      undefined,
      expect.anything(),
    );
    expect(buildGroundedPrompt).toHaveBeenCalledWith(
      message,
      expect.any(Array),
      [{
        question: "What revenue was reported for Q2?",
        answer: "Standalone revenue was ₹1,245.6 crore. [S1]",
      }],
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