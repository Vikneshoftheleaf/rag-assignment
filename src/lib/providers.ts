const timeout = 12_000;
const primaryTextModel = "@cf/qwen/qwen3-30b-a3b-fp8";
const fallbackTextModel = "@cf/meta/llama-3.2-3b-instruct";
const primaryTranscriptionModel = "@cf/openai/whisper-large-v3-turbo";
const fallbackTranscriptionModel = "@cf/openai/whisper";

export type ChatMessage = { role: "system" | "user"; content: string };

export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "ProviderError";
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required server environment variable: ${name}`);
  return value;
}

function modelPath(model: string): string {
  return model.split("/").map((part) => encodeURIComponent(part)).join("/");
}

async function readJson(response: Response, provider: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new ProviderError(
      `${provider} returned HTTP ${response.status}`,
      response.status === 429 || response.status >= 500,
    );
  }
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new ProviderError(`${provider} returned invalid JSON`, true);
  }
}

export async function embedText(text: string): Promise<number[]> {
  const account = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
  const token = requiredEnv("CLOUDFLARE_API_TOKEN");
  const model = process.env.CF_EMBEDDING_MODEL || "@cf/baai/bge-base-en-v1.5";
  const expectedDimensions = Number(process.env.CF_EMBEDDING_DIMENSIONS || "768");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${modelPath(model)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: [text] }),
      signal: AbortSignal.timeout(timeout),
    },
  );
  const payload = await readJson(response, "Cloudflare Workers AI embeddings");
  const result = payload.result as { data?: unknown; shape?: number[] } | undefined;
  const first = Array.isArray(result?.data) && Array.isArray(result.data[0])
    ? result.data[0]
    : Array.isArray(payload.data) && Array.isArray(payload.data[0])
      ? payload.data[0]
      : null;
  if (!first || !first.every((item) => typeof item === "number")) {
    throw new ProviderError("Cloudflare returned an unexpected embedding response", false);
  }
  if (first.length !== expectedDimensions) {
    throw new ProviderError(
      `Embedding dimension mismatch: expected ${expectedDimensions}, received ${first.length}`,
      false,
    );
  }
  return first as number[];
}

async function cloudflareGenerate(messages: ChatMessage[], model: string): Promise<string> {
  const account = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
  const token = requiredEnv("CLOUDFLARE_API_TOKEN");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${modelPath(model)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        max_tokens: 900,
        temperature: 0.15,
      }),
      signal: AbortSignal.timeout(timeout),
    },
  );
  const payload = await readJson(response, `Cloudflare Workers AI (${model})`);
  const result = payload.result as { response?: string } | undefined;
  const text = result?.response?.trim();
  if (!text) throw new ProviderError(`Cloudflare Workers AI (${model}) returned no answer`, true);
  return text;
}

async function cloudflareGenerateStream(
  messages: ChatMessage[],
  model: string,
): Promise<AsyncIterable<string>> {
  const account = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
  const token = requiredEnv("CLOUDFLARE_API_TOKEN");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${modelPath(model)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        max_tokens: 900,
        temperature: 0.15,
        stream: true,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new ProviderError(
      `Cloudflare Workers AI (${model}) returned HTTP ${response.status}`,
      response.status === 429 || response.status >= 500,
    );
  }
  if (!response.body) {
    throw new ProviderError(`Cloudflare Workers AI (${model}) returned no stream`, true);
  }

  return parseCloudflareTextStream(response.body, model);
}

async function* parseCloudflareTextStream(
  body: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedText = false;

  function parseLine(line: string): string | null {
    if (!line.startsWith("data:")) return null;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return null;

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new ProviderError(`Cloudflare Workers AI (${model}) returned invalid stream data`, true);
    }

    if (!payload || typeof payload !== "object") return null;
    const record = payload as { response?: unknown; result?: { response?: unknown } };
    const token = typeof record.response === "string"
      ? record.response
      : typeof record.result?.response === "string"
        ? record.result.response
        : "";
    return token || null;
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const token = parseLine(line);
        if (token) {
          receivedText = true;
          yield token;
        }
      }
      if (done) break;
    }

    if (buffer) {
      const token = parseLine(buffer);
      if (token) {
        receivedText = true;
        yield token;
      }
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      `Cloudflare Workers AI (${model}) stream failed`,
      !receivedText && transientFailure(error),
    );
  } finally {
    reader.releaseLock();
  }

  if (!receivedText) {
    throw new ProviderError(`Cloudflare Workers AI (${model}) returned no answer`, true);
  }
}

async function cloudflareTranscriptionRequest(model: string, body: unknown): Promise<Response> {
  const account = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
  const token = requiredEnv("CLOUDFLARE_API_TOKEN");
  return fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${modelPath(model)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    },
  );
}

function transientFailure(error: unknown): boolean {
  return error instanceof TypeError ||
    (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError"));
}

export async function transcribeWithFallback(
  audio: Uint8Array,
  primary = async (input: Uint8Array) => {
    const response = await cloudflareTranscriptionRequest(
      process.env.CF_PRIMARY_STT_MODEL || primaryTranscriptionModel,
      { audio: Buffer.from(input).toString("base64"), task: "transcribe", vad_filter: true },
    );
    const payload = await readJson(response, "Cloudflare Workers AI transcription");
    const result = payload.result as { text?: unknown } | undefined;
    const text = typeof result?.text === "string" ? result.text.trim() : "";
    if (!text) throw new ProviderError("Cloudflare transcription returned no text", true);
    return text;
  },
  fallback = async (input: Uint8Array) => {
    const response = await cloudflareTranscriptionRequest(
      process.env.CF_FALLBACK_STT_MODEL || fallbackTranscriptionModel,
      { audio: Array.from(input) },
    );
    const payload = await readJson(response, "Cloudflare Workers AI fallback transcription");
    const result = payload.result as { text?: unknown } | undefined;
    const text = typeof result?.text === "string" ? result.text.trim() : "";
    if (!text) throw new ProviderError("Cloudflare fallback transcription returned no text", true);
    return text;
  },
): Promise<{ text: string; provider: "cloudflare-primary" | "cloudflare-fallback" }> {
  try {
    return { text: await primary(audio), provider: "cloudflare-primary" };
  } catch (error) {
    const shouldRetry = error instanceof ProviderError ? error.retryable : transientFailure(error);
    if (!shouldRetry) throw error;
    return { text: await fallback(audio), provider: "cloudflare-fallback" };
  }
}

export async function generateWithFallback(
  messages: ChatMessage[],
  primary = (input: ChatMessage[]) => cloudflareGenerate(
    input,
    process.env.CF_PRIMARY_TEXT_MODEL || primaryTextModel,
  ),
  fallback = (input: ChatMessage[]) => cloudflareGenerate(
    input,
    process.env.CF_FALLBACK_TEXT_MODEL || fallbackTextModel,
  ),
): Promise<{ text: string; provider: "cloudflare-primary" | "cloudflare-fallback" }> {
  try {
    return { text: await primary(messages), provider: "cloudflare-primary" };
  } catch (error) {
    const shouldRetry = error instanceof ProviderError ? error.retryable : transientFailure(error);
    if (!shouldRetry) throw error;
    return { text: await fallback(messages), provider: "cloudflare-fallback" };
  }
}

export async function* generateStreamWithFallback(
  messages: ChatMessage[],
  primary = (input: ChatMessage[]) => cloudflareGenerateStream(
    input,
    process.env.CF_PRIMARY_TEXT_MODEL || primaryTextModel,
  ),
  fallback = (input: ChatMessage[]) => cloudflareGenerateStream(
    input,
    process.env.CF_FALLBACK_TEXT_MODEL || fallbackTextModel,
  ),
): AsyncGenerator<{ text: string; provider: "cloudflare-primary" | "cloudflare-fallback" }> {
  let hasEmittedText = false;
  try {
    const stream = await primary(messages);
    for await (const text of stream) {
      hasEmittedText = true;
      yield { text, provider: "cloudflare-primary" };
    }
  } catch (error) {
    const shouldRetry = error instanceof ProviderError ? error.retryable : transientFailure(error);
    if (hasEmittedText || !shouldRetry) throw error;

    const stream = await fallback(messages);
    for await (const text of stream) {
      yield { text, provider: "cloudflare-fallback" };
    }
  }
}
