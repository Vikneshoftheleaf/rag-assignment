import { describe, expect, it, vi } from "vitest";
import { generateWithFallback, ProviderError } from "./providers";

describe("answer provider fallback", () => {
  it("uses the primary Cloudflare model when it succeeds", async () => {
    const fallback = vi.fn(async () => "fallback answer");
    const result = await generateWithFallback(
      [{ role: "user", content: "question" }],
      async () => "primary answer",
      fallback,
    );
    expect(result).toEqual({ text: "primary answer", provider: "cloudflare-primary" });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back for transient primary-provider errors", async () => {
    const result = await generateWithFallback(
      [{ role: "user", content: "question" }],
      async () => { throw new ProviderError("rate limited", true); },
      async () => "backup answer",
    );
    expect(result).toEqual({ text: "backup answer", provider: "cloudflare-fallback" });
  });

  it("does not hide a non-retryable primary configuration error", async () => {
    const fallback = vi.fn(async () => "fallback answer");
    await expect(generateWithFallback(
      [{ role: "user", content: "question" }],
      async () => { throw new ProviderError("bad request", false); },
      fallback,
    )).rejects.toThrow("bad request");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("uses the configured Cloudflare model ids for primary and fallback requests", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ result: { response: "backup answer" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "test-account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
    vi.stubEnv("CF_PRIMARY_TEXT_MODEL", "@cf/test/primary");
    vi.stubEnv("CF_FALLBACK_TEXT_MODEL", "@cf/test/fallback");

    try {
      const result = await generateWithFallback([{ role: "user", content: "question" }]);

      expect(result).toEqual({ text: "backup answer", provider: "cloudflare-fallback" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toContain("/ai/run/%40cf/test/primary");
      expect(fetchMock.mock.calls[1][0]).toContain("/ai/run/%40cf/test/fallback");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
