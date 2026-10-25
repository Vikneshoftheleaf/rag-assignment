import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCacheConfigurationHash, buildQuestionKey } from "./chat-cache";

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
});
