import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildCacheConfigurationHash,
  buildGroundedPrompt,
  buildQuestionKey,
  formatCitations,
  generateStreamWithFallback,
  generateWithFallback,
  getCorpusRevision,
  getSupabase,
  keepCitedSources,
  readCachedResponse,
  retrieveEvidence,
  writeCachedResponse,
  applyQueryPolicy,
} = vi.hoisted(() => ({
  buildCacheConfigurationHash: vi.fn(() => "configuration"),
  buildGroundedPrompt: vi.fn((question: string, records: Array<{ result_kind: string }>) =>
    question ? records.slice(0, 0) : []),
  buildQuestionKey: vi.fn(() => "question"),
  formatCitations: vi.fn(() => []),
  generateStreamWithFallback: vi.fn(),
  generateWithFallback: vi.fn(),
  getCorpusRevision: vi.fn(),
  getSupabase: vi.fn(),
  keepCitedSources: vi.fn(),
  readCachedResponse: vi.fn(),
  retrieveEvidence: vi.fn(),
  writeCachedResponse: vi.fn(),
  applyQueryPolicy: vi.fn(),
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
}));

vi.mock("@/lib/prompt", () => ({ buildGroundedPrompt }));
vi.mock("@/lib/query-policy", () => ({ applyQueryPolicy }));

import { POST } from "./route";

describe("POST /api/chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSupabase.mockReturnValue({});
    getCorpusRevision.mockResolvedValue("corpus-revision");
    readCachedResponse.mockResolvedValue(null);
    retrieveEvidence.mockResolvedValue([{
      score: 0.9,
      source_filename: "minutes.docx",
    }]);
    formatCitations.mockReturnValue([]);
    keepCitedSources.mockImplementation((answer) => ({ answer, citations: [] }));
    writeCachedResponse.mockResolvedValue(undefined);
    applyQueryPolicy.mockReturnValue({ allowed: true });
    generateStreamWithFallback.mockImplementation(async function* () {
      yield { text: "Summary text.", provider: "cloudflare-primary" };
    });
  });

  it("retrieves only the selected document when streaming a document summary", async () => {
    const documentId = "123e4567-e89b-42d3-a456-426614174000";
    const message = "Summarize the key information in minutes.docx.";
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ message, documentId }),
    });

    const response = await POST(request);
    const stream = await response.text();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(retrieveEvidence).toHaveBeenCalledWith(message, documentId);
    expect(buildQuestionKey).toHaveBeenCalledWith(`${message}\ndocument:${documentId}`);
    expect(stream).toContain('event: token\ndata: {"text":"Summary text."}');
    expect(stream).toContain('"answer":"Summary text."');
  });

  it("prioritizes numeric facts and keeps a wider evidence set for financial questions", async () => {
    const records = Array.from({ length: 15 }, (_, index) => ({
      score: 0.9,
      result_id: `record-${index}`,
      result_kind: index < 8 ? "fact" : "chunk",
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
    expect(selected).toHaveLength(12);
    expect(selected.slice(0, 8).every((record) => record.result_kind === "fact")).toBe(true);
    expect(selected.slice(8).every((record) => record.result_kind === "chunk")).toBe(true);
  });

  it("returns a redirect for out-of-scope questions without retrieving evidence", async () => {
    applyQueryPolicy.mockReturnValue({ allowed: false, answer: "Use the document assistant." });
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ message: "Tell me a joke." }),
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