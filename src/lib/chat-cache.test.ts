import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildCacheConfigurationHash, buildQuestionKey, writeCachedResponse } from "./chat-cache";

describe("chat response cache keys", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes question whitespace and casing", () => {
    expect(buildQuestionKey("  What is   revenue? ")).toBe(buildQuestionKey("what is revenue?"));
  });

  it("uses different keys for different questions", () => {
    expect(buildQuestionKey("Question one")).not.toBe(buildQuestionKey("Question two"));
  });

  it("invalidates configuration when the generation model changes", () => {
    vi.stubEnv("CF_PRIMARY_TEXT_MODEL", "@cf/example/model-a");
    const firstConfiguration = buildCacheConfigurationHash();

    vi.stubEnv("CF_PRIMARY_TEXT_MODEL", "@cf/example/model-b");

    expect(buildCacheConfigurationHash()).not.toBe(firstConfiguration);
  });

  it("upserts cached answers by question, corpus, and configuration", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const client = {
      from: vi.fn(() => ({
        upsert,
      })),
    } as unknown as SupabaseClient;

    await writeCachedResponse(
      client,
      buildQuestionKey("What did the board approve?"),
      "a".repeat(64),
      "b".repeat(64),
      {
        answer: "Approved budget.",
        citations: [],
        abstained: false,
        feedbackId: "turn-id",
        retrievalMatchPercent: 82,
        feedbackApprovalPercent: 75,
        feedbackRatingsCount: 4,
      },
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        question_key: buildQuestionKey("What did the board approve?"),
        corpus_revision: "a".repeat(64),
        configuration_hash: "b".repeat(64),
        response: expect.objectContaining({
          retrievalMatchPercent: 82,
        }),
      }),
      { onConflict: "question_key, corpus_revision, configuration_hash" },
    );
    expect(upsert.mock.calls[0][0].response).not.toHaveProperty("feedbackId");
    expect(upsert.mock.calls[0][0].response).not.toHaveProperty("feedbackApprovalPercent");
  });
});
