import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock, embedTextMock, rpcMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  embedTextMock: vi.fn(),
  rpcMock: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

vi.mock("@/lib/providers", () => ({
  embedText: embedTextMock,
}));

import { retrieveEvidence } from "./retrieval";

describe("document-scoped retrieval", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
    embedTextMock.mockResolvedValue([0.1, 0.2]);
    rpcMock.mockResolvedValue({ data: [], error: null });
    createClientMock.mockReturnValue({ rpc: rpcMock });
  });

  it("uses the document search RPC and passes the selected document id", async () => {
    await retrieveEvidence("Summarize the board minutes.", "document-uuid");

    expect(rpcMock).toHaveBeenCalledWith("document_hybrid_search", {
      query_embedding: "[0.1,0.2]",
      query_text: "Summarize the board minutes.",
      match_count: 20,
      target_document_id: "document-uuid",
    });
  });

  it("requests a larger corpus-wide candidate set for better structured-fact recall", async () => {
    await retrieveEvidence("What decision was recorded?");

    expect(rpcMock).toHaveBeenCalledWith("hybrid_search", {
      query_embedding: "[0.1,0.2]",
      query_text: "What decision was recorded?",
      match_count: 20,
    });
  });
});
