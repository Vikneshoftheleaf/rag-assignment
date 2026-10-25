import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildCacheConfigurationHash,
  buildQuestionKey,
  getCorpusRevision,
  readCachedResponse,
  writeCachedResponse,
} from "@/lib/chat-cache";
import { generateStreamWithFallback, generateWithFallback } from "@/lib/providers";
import { formatCitations, getSupabase, keepCitedSources, retrieveEvidence } from "@/lib/retrieval";
import { buildGroundedPrompt } from "@/lib/prompt";
import { applyQueryPolicy } from "@/lib/query-policy";
import type { ChatResponse } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  documentId: z.string().uuid().optional(),
});

const MIN_RELEVANCE = Number(process.env.RETRIEVAL_MIN_SCORE || "0.18");

type StreamCallbacks = {
  onStatus: (status: string) => void;
  onToken: (token: string) => void;
};

async function answerQuestion(
  message: string,
  streamCallbacks?: StreamCallbacks,
  documentId?: string,
): Promise<ChatResponse> {
  streamCallbacks?.onStatus("Finding relevant passages…");
  const supabase = getSupabase();
  const questionKey = buildQuestionKey(documentId ? `${message}\ndocument:${documentId}` : message);
  const corpusRevision = await getCorpusRevision(supabase);
  const configurationHash = buildCacheConfigurationHash();
  try {
    const cached = await readCachedResponse(supabase, questionKey, corpusRevision, configurationHash);
    if (cached) return cached;
  } catch (error) {
    console.error("Chat cache read failed; continuing without cache", error);
  }

  const retrieved = await retrieveEvidence(message, documentId);
  const eligible = retrieved.filter((record) => Number(record.score) >= MIN_RELEVANCE);
  const numericOrFinancialQuestion =
    /\b(?:revenue|turnover|sales|price|amount|cost|expense|profit|loss|margin|ebitda|eps|financial|quarter|half[\s-]*year|fiscal|percentage|percent)\b/i
      .test(message);
  const ranked = numericOrFinancialQuestion
    ? [...eligible.filter((record) => record.result_kind === "fact"), ...eligible.filter((record) => record.result_kind !== "fact")]
    : eligible;
  const selected = ranked.slice(0, documentId ? 20 : numericOrFinancialQuestion ? 12 : 6);
  if (!selected.length) {
    return {
      answer: "I couldn’t find enough supporting information in the indexed Silverline sample documents to answer that.",
      citations: [],
      abstained: true,
    };
  }

  const prompt = buildGroundedPrompt(message, selected);
  let answer: string;
  let provider: ChatResponse["provider"];
  if (streamCallbacks) {
    streamCallbacks.onStatus("Writing an answer from the sources…");
    let generated = "";
    for await (const chunk of generateStreamWithFallback(prompt)) {
      generated += chunk.text;
      provider = chunk.provider;
      streamCallbacks.onToken(chunk.text);
    }
    answer = generated;
  } else {
    const result = await generateWithFallback(prompt);
    answer = result.text;
    provider = result.provider;
  }

  const cited = keepCitedSources(answer, formatCitations(selected));
  const response: ChatResponse = {
    answer: cited.answer,
    citations: cited.citations,
    abstained: false,
    provider,
  };
  try {
    await writeCachedResponse(supabase, questionKey, corpusRevision, configurationHash, response);
  } catch (error) {
    console.error("Chat cache write failed; returning generated answer", error);
  }
  return response;
}

function createEventStream(run: (emit: (event: string, data: unknown) => void) => Promise<void>) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, data: unknown) => {
        if (cancelled) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      void run(emit).then(
        () => {
          if (!cancelled) controller.close();
        },
        (error: unknown) => {
          console.error("Streaming chat request failed", error);
          emit("error", {
            error: "The assistant is temporarily unavailable. Check the server configuration and try again.",
          });
          if (!cancelled) controller.close();
        },
      );
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a question between 1 and 2000 characters." }, { status: 400 });
  }

  const policy = applyQueryPolicy(parsed.data.message);
  if (!policy.allowed) {
    const response: ChatResponse = {
      answer: policy.answer,
      citations: [],
      abstained: true,
    };
    return NextResponse.json(response);
  }

  if (request.headers.get("accept")?.includes("text/event-stream")) {
    return createEventStream(async (emit) => {
      const response = await answerQuestion(parsed.data.message, {
        onStatus: (status) => emit("status", { status }),
        onToken: (text) => emit("token", { text }),
      }, parsed.data.documentId);
      emit("final", response);
    });
  }

  try {
    const response = await answerQuestion(parsed.data.message, undefined, parsed.data.documentId);
    return NextResponse.json(response);
  } catch (error) {
    console.error("Chat request failed", error);
    return NextResponse.json(
      { error: "The assistant is temporarily unavailable. Check the server configuration and try again." },
      { status: 503 },
    );
  }
}
