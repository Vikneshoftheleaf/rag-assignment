import { describe, expect, it, vi } from "vitest";
import {
  generateWithFallback,
  generateStreamWithFallback,
  ProviderError,
  transcribeWithFallback,
} from "./providers";

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

  it("streams text from the primary model as incremental chunks", async () => {
    const primary = vi.fn(async () => (async function* () {
      yield "A streamed";
      yield " answer.";
    })());
    const fallback = vi.fn(async () => (async function* () { yield "backup"; })());
    const chunks = [];
    for await (const chunk of generateStreamWithFallback(
      [{ role: "user", content: "question" }],
      primary,
      fallback,
    )) chunks.push(chunk);

    expect(chunks).toEqual([
      { text: "A streamed", provider: "cloudflare-primary" },
      { text: " answer.", provider: "cloudflare-primary" },
    ]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back when the primary stream fails before emitting answer text", async () => {
    const fallback = vi.fn(async () => (async function* () {
      yield "backup answer";
    })());
    const chunks = [];
    for await (const chunk of generateStreamWithFallback(
      [{ role: "user", content: "question" }],
      async () => { throw new ProviderError("rate limited", true); },
      fallback,
    )) chunks.push(chunk);

    expect(chunks).toEqual([{ text: "backup answer", provider: "cloudflare-fallback" }]);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("does not switch models after primary text has already streamed", async () => {
    const fallback = vi.fn(async () => (async function* () { yield "backup"; })());
    const primary = async () => (async function* () {
      yield "partial";
      throw new ProviderError("stream interrupted", true);
    })();

    const stream = generateStreamWithFallback(
      [{ role: "user", content: "question" }],
      primary,
      fallback,
    );
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { text: "partial", provider: "cloudflare-primary" },
    });
    await expect(stream.next()).rejects.toThrow("stream interrupted");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("parses Cloudflare SSE chunks and requests streaming generation", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"response":"Hello"}\n\n'));
        controller.enqueue(encoder.encode('data: {"response":" world"}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "test-account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");

    try {
      const chunks = [];
      for await (const chunk of generateStreamWithFallback([{ role: "user", content: "question" }])) {
        chunks.push(chunk);
      }
      expect(chunks.map((chunk) => chunk.text)).toEqual(["Hello", " world"]);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  describe("speech provider fallback", () => {
    it("uses Whisper Turbo first and falls back to Cloudflare Whisper on transient failures", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response("{}", { status: 503 }))
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ result: { text: "transcribed question" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ));
      vi.stubGlobal("fetch", fetchMock);
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "test-account");
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");

      try {
        const result = await transcribeWithFallback(new Uint8Array([1, 2, 3]));
        expect(result).toEqual({ text: "transcribed question", provider: "cloudflare-fallback" });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0][0]).toContain("/ai/run/%40cf/openai/whisper-large-v3-turbo");
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
          audio: Buffer.from([1, 2, 3]).toString("base64"),
          task: "transcribe",
        });
        expect(fetchMock.mock.calls[1][0]).toContain("/ai/run/%40cf/openai/whisper");
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ audio: [1, 2, 3] });
      } finally {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    });

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
