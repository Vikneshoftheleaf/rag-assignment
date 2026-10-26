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

  it("does not add spaces when the provider splits a word or identifier across chunks", async () => {
    const primary = async () => (async function* () {
      yield "Dec";
      yield "isions";
      yield " Q";
      yield "2";
    })();
    const chunks = [];
    for await (const chunk of generateStreamWithFallback(
      [{ role: "user", content: "question" }],
      primary,
    )) chunks.push(chunk);

    expect(chunks.map((chunk) => chunk.text).join("")).toBe("Decisions Q2");
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

  it("recovers with a non-streaming fallback when both streams finish without answer text", async () => {
    const primary = vi.fn(async () => (async function* () {
      throw new ProviderError("primary stream had no answer", true);
    })());
    const fallback = vi.fn(async () => (async function* () {
      throw new ProviderError("fallback stream had no answer", true);
    })());
    const fallbackNonStreaming = vi.fn(async () => "Recovered backup answer");
    const chunks = [];

    for await (const chunk of generateStreamWithFallback(
      [{ role: "user", content: "question" }],
      primary,
      fallback,
      fallbackNonStreaming,
    )) chunks.push(chunk);

    expect(chunks).toEqual([
      { text: "Recovered backup answer", provider: "cloudflare-fallback" },
    ]);
    expect(fallbackNonStreaming).toHaveBeenCalledOnce();
  });

  it("completes an interrupted fallback after it has emitted text without restarting the full answer", async () => {
    const fallbackNonStreaming = vi.fn(async (messages: Array<{ role: string; content: string }>) =>
      messages.length ? "Completed backup answer" : "");
    const fallback = async () => (async function* () {
      yield "partial";
      throw new ProviderError("stream interrupted", true);
    })();
    const stream = generateStreamWithFallback(
      [{ role: "user", content: "question" }],
      async () => { throw new ProviderError("primary unavailable", true); },
      fallback,
      fallbackNonStreaming,
    );

    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { text: "partial", provider: "cloudflare-fallback" },
    });
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { text: " Completed backup answer", provider: "cloudflare-fallback" },
    });
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
    expect(fallbackNonStreaming).toHaveBeenCalledOnce();
    expect(fallbackNonStreaming.mock.calls[0][0]).toContainEqual({
      role: "assistant",
      content: "partial",
    });
  });

  it("separates words at interrupted continuation boundaries", async () => {
    const completePartial = vi.fn(async () => "continues.");
    const primary = async () => (async function* () {
      yield "This sentence";
      throw new ProviderError("stream interrupted", true);
    })();
    const stream = generateStreamWithFallback(
      [{ role: "user", content: "question" }],
      primary,
      undefined,
      undefined,
      completePartial,
    );

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe("This sentence continues.");
  });

  it("removes repeated text when completing an interrupted stream", async () => {
    const completePartial = vi.fn(async () =>
      "Only agenda items are listed. Where an excerpt did not specify an owner.",
    );
    const primary = async () => (async function* () {
      yield "Only agenda items are listed. Where an excerpt did not";
      throw new ProviderError("stream interrupted", true);
    })();
    const stream = generateStreamWithFallback(
      [{ role: "user", content: "question" }],
      primary,
      undefined,
      undefined,
      completePartial,
    );

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(
      "Only agenda items are listed. Where an excerpt did not specify an owner.",
    );
  });

  it("does not switch models after primary text has already streamed", async () => {
    const fallback = vi.fn(async () => (async function* () { yield "backup"; })());
    const primary = async () => (async function* () {
      yield "partial";
      throw new ProviderError("stream interrupted", true);
    })();

    const completePartial = vi.fn(async () => " completed");
    const stream = generateStreamWithFallback(
      [{ role: "user", content: "question" }],
      primary,
      fallback,
      undefined,
      completePartial,
    );
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { text: "partial", provider: "cloudflare-primary" },
    });
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { text: " completed", provider: "cloudflare-primary" },
    });
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
    expect(fallback).not.toHaveBeenCalled();
    expect(completePartial).toHaveBeenCalledOnce();
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

  it("parses OpenAI-compatible GPT-OSS choice deltas and ignores reasoning-only chunks", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n' +
          'data: {"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"Grounded"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":" answer."},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
        ));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "test-account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
    vi.stubEnv("CF_PRIMARY_TEXT_MODEL", "@cf/openai/gpt-oss-120b");

    try {
      const chunks = [];
      for await (const chunk of generateStreamWithFallback([{ role: "user", content: "question" }])) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([
        { text: "Grounded", provider: "cloudflare-primary" },
        { text: " answer.", provider: "cloudflare-primary" },
      ]);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(1600);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("continues a response when GPT-OSS reaches its token limit", async () => {
    const encoder = new TextEncoder();
    const makeStream = (content: string, finishReason: string) =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }] })}\n\n` +
            "data: [DONE]\n\n",
          ));
          controller.close();
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeStream("First complete section.", "length"))
      .mockResolvedValueOnce(makeStream(" Final conclusion.", "stop"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "test-account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
    vi.stubEnv("CF_PRIMARY_TEXT_MODEL", "@cf/openai/gpt-oss-120b");

    try {
      const chunks = [];
      for await (const chunk of generateStreamWithFallback([
        { role: "user", content: "Write a sourced answer." },
      ])) chunks.push(chunk);

      expect(chunks.map((chunk) => chunk.text).join("")).toBe("First complete section. Final conclusion.");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstRequest = JSON.parse(fetchMock.mock.calls[0][1].body);
      const continuationRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(firstRequest.max_tokens).toBe(1600);
      expect(continuationRequest.max_tokens).toBe(1600);
      expect(continuationRequest.messages).toContainEqual({
        role: "assistant",
        content: "First complete section.",
      });
      expect(continuationRequest.messages.at(-1).content).toContain("Continue exactly where");
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

  it("uses OpenAI GPT-OSS 120B as primary and GPT-OSS 20B as fallback by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ result: { response: "grounded answer" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "test-account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
    vi.stubEnv("CF_PRIMARY_TEXT_MODEL", "");
    vi.stubEnv("CF_FALLBACK_TEXT_MODEL", "");

    try {
      const result = await generateWithFallback([{ role: "user", content: "question" }]);

      expect(result).toEqual({ text: "grounded answer", provider: "cloudflare-primary" });
      expect(fetchMock.mock.calls[0][0]).toContain(
        "/ai/run/%40cf/openai/gpt-oss-120b",
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("reads OpenAI-compatible message content from non-streaming GPT-OSS responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ result: { choices: [{ message: { role: "assistant", content: "Grounded answer." } }] } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "test-account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");

    try {
      await expect(generateWithFallback([{ role: "user", content: "question" }])).resolves.toEqual({
        text: "Grounded answer.",
        provider: "cloudflare-primary",
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("continues non-streaming GPT-OSS responses stopped by the output limit", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          result: {
            choices: [{
              message: { role: "assistant", content: "First section." },
              finish_reason: "length",
            }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          result: {
            choices: [{
              message: { role: "assistant", content: "Final section." },
              finish_reason: "stop",
            }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "test-account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");

    try {
      await expect(generateWithFallback([{ role: "user", content: "question" }])).resolves.toEqual({
        text: "First section. Final section.",
        provider: "cloudflare-primary",
      });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(1600);
      const continuation = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(continuation.messages).toContainEqual({
        role: "assistant",
        content: "First section.",
      });
      expect(continuation.messages.at(-1).content).toContain("Continue exactly where");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("uses GPT-OSS 20B when GPT-OSS 120B has a transient failure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ result: { response: "backup answer" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "test-account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
    vi.stubEnv("CF_PRIMARY_TEXT_MODEL", "");
    vi.stubEnv("CF_FALLBACK_TEXT_MODEL", "");

    try {
      const result = await generateWithFallback([{ role: "user", content: "question" }]);

      expect(result).toEqual({ text: "backup answer", provider: "cloudflare-fallback" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toContain("/ai/run/%40cf/openai/gpt-oss-120b");
      expect(fetchMock.mock.calls[1][0]).toContain("/ai/run/%40cf/openai/gpt-oss-20b");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
