import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  buildCacheConfigurationHash,
  buildQuestionKey,
  getCorpusRevision,
  readCachedResponse,
  writeCachedResponse,
} from "@/lib/chat-cache";
import { generateStreamWithFallback, generateWithFallback } from "@/lib/providers";
import {
  formatCitations,
  getSupabase,
  keepCitedSources,
  prepareFeedbackRetrieval,
  retrieveEvidence,
} from "@/lib/retrieval";
import { buildGroundedPrompt, buildTransformPrompt } from "@/lib/prompt";
import { applyQueryPolicy } from "@/lib/query-policy";
import { getRequestUser } from "@/lib/supabase-auth";
import { repairSplitWords } from "@/lib/answer-format";
import { selectEvidence } from "@/lib/evidence-selection";
import type { ChatResponse } from "@/lib/types";
import {
  getFeedbackStats,
  getRetrievalMatchPercent,
  recordTurnFeedback,
  toFeedbackSources,
} from "@/lib/turn-feedback";
import {
  determineConversationIntent,
  type ConversationTurn,
} from "@/lib/conversation-intent";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  turnId: z.string().uuid().optional(),
  documentId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
});

const MIN_RELEVANCE = Number(process.env.RETRIEVAL_MIN_SCORE || "0.18");

type StreamCallbacks = {
  onStatus: (status: string) => void;
  onToken: (token: string) => void;
};

async function answerQuestion(
  message: string,
  userId: string,
  turnId: string,
  sessionId?: string,
  streamCallbacks?: StreamCallbacks,
  documentId?: string,
): Promise<ChatResponse> {
  streamCallbacks?.onStatus("Finding relevant passages…");
  const supabase = getSupabase();
  const history = await loadConversationHistory(supabase, userId, sessionId, turnId);
  const intent = determineConversationIntent(message, history);
  const retrievalQuestion = intent.kind === "search" ? intent.retrievalQuestion : message;
  const questionKey = buildQuestionKey([
    retrievalQuestion,
    `document:${documentId || ""}`,
    intent.kind,
  ].join("\n"));
  const corpusRevision = await getCorpusRevision(supabase);
  const configurationHash = buildCacheConfigurationHash();
  if (intent.kind === "transform") {
    const prompt = buildTransformPrompt(message, intent.previousTurn.answer);
    let generated: string;
    let provider: ChatResponse["provider"];
    if (streamCallbacks) {
      streamCallbacks.onStatus("Reformatting the previous answer…");
      generated = "";
      for await (const chunk of generateStreamWithFallback(prompt)) {
        generated += chunk.text;
        provider = chunk.provider;
        streamCallbacks.onToken(chunk.text);
      }
    } else {
      const result = await generateWithFallback(prompt);
      generated = result.text;
      provider = result.provider;
    }
    const polished = repairSplitWords(generated, [message, intent.previousTurn.answer]);
    const cited = keepCitedSources(polished, intent.previousTurn.citations);
    const response: ChatResponse = {
      answer: cited.answer,
      citations: cited.citations,
      abstained: false,
      intent: "transform",
      provider,
      retrievalMatchPercent: intent.previousTurn.retrievalMatchPercent,
    };
    return response;
  }

  const feedbackContext = await prepareFeedbackRetrieval(
    retrievalQuestion,
    userId,
    corpusRevision,
    documentId,
  );
  if (!feedbackContext.hasMatches && history.length === 0) {
    try {
      const cached = await readCachedResponse(supabase, questionKey, corpusRevision, configurationHash);
      if (cached) {
        const response = {
          ...cached,
          intent: "search" as const,
          retrievalMatchPercent: cached.retrievalMatchPercent ??
            getRetrievalMatchPercent(cached.citations),
        };
        return addFeedbackMetadata(response, {
          turnId,
          userId,
          documentId,
          message,
          corpusRevision,
          queryEmbedding: feedbackContext.queryEmbedding,
          sources: cached.citations.map((citation) => ({
            sourceId: citation.sourceId || "",
            kind: citation.kind,
            content: citation.excerpt,
            filename: citation.filename,
            location: citation.location,
            score: citation.score,
          })).filter((source) => source.sourceId),
        }, supabase);
      }
    } catch (error) {
      console.error("Chat cache read failed; continuing without cache", error);
    }
  }

  const retrieved = await retrieveEvidence(retrievalQuestion, documentId, feedbackContext);
  const eligible = retrieved.filter((record) => Number(record.score) >= MIN_RELEVANCE);
  const selected = selectEvidence(message, eligible, 20);
  if (!selected.length) {
    return addFeedbackMetadata({
      answer: "I couldn’t find enough supporting information in the indexed Silverline sample documents to answer that.",
      citations: [],
      abstained: true,
      intent: "search",
      retrievalMatchPercent: null,
    }, {
      turnId,
      userId,
      documentId,
      message,
      corpusRevision,
      queryEmbedding: feedbackContext.queryEmbedding,
      sources: [],
    }, supabase);
  }

  const prompt = buildGroundedPrompt(
    message,
    selected,
    history.map(({ question, answer }) => ({ question, answer })),
  );
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

  const polishedAnswer = repairSplitWords(
    answer,
    [message, ...selected.map((record) => record.content)],
  );
  const cited = keepCitedSources(polishedAnswer, formatCitations(selected));
  const response: ChatResponse = {
    answer: cited.answer,
    citations: cited.citations,
    abstained: false,
    intent: "search",
    provider,
    retrievalMatchPercent: getRetrievalMatchPercent(selected),
  };
  if (history.length === 0 && !feedbackContext.hasMatches) {
    try {
      await writeCachedResponse(supabase, questionKey, corpusRevision, configurationHash, response);
    } catch (error) {
      console.error("Chat cache write failed; returning generated answer", error);
    }
  }
  return addFeedbackMetadata(response, {
    turnId,
    userId,
    documentId,
    message,
    corpusRevision,
    queryEmbedding: feedbackContext.queryEmbedding,
    sources: toFeedbackSources(selected),
  }, supabase);
}

async function addFeedbackMetadata(
  response: ChatResponse,
  input: {
    turnId: string;
    userId: string;
    documentId?: string;
    message: string;
    corpusRevision: string;
    queryEmbedding: number[];
    sources: ReturnType<typeof toFeedbackSources>;
  },
  supabase: ReturnType<typeof getSupabase>,
): Promise<ChatResponse> {
  try {
    await recordTurnFeedback(supabase, {
      turnId: input.turnId,
      userId: input.userId,
      documentId: input.documentId,
      question: input.message,
      answer: response.answer,
      sources: input.sources,
      queryEmbedding: input.queryEmbedding,
      corpusRevision: input.corpusRevision,
      retrievalMatchPercent: response.retrievalMatchPercent ?? null,
    });
  } catch (error) {
    console.error("Could not store answer feedback context", error);
    return response;
  }

  try {
    const stats = await getFeedbackStats(supabase, input.userId);
    return {
      ...response,
      feedbackId: input.turnId,
      feedbackApprovalPercent: stats.approvalPercent,
      feedbackRatingsCount: stats.positiveCount + stats.negativeCount,
    };
  } catch (error) {
    console.error("Could not load answer feedback statistics", error);
    return { ...response, feedbackId: input.turnId };
  }
}

const conversationCitationSchema = z.object({
  id: z.string(),
  sourceId: z.string().optional(),
  filename: z.string(),
  documentType: z.enum(["pdf", "docx", "xlsx"]),
  location: z.record(z.string(), z.unknown()),
  excerpt: z.string(),
  kind: z.enum(["chunk", "fact"]),
  score: z.number(),
});

async function loadConversationHistory(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  sessionId: string | undefined,
  currentTurnId: string,
): Promise<ConversationTurn[]> {
  if (!sessionId) return [];

  const { data: session, error: sessionError } = await supabase
    .from("chat_sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (sessionError) throw new Error(`Could not verify conversation history: ${sessionError.message}`);
  if (!session) throw new Error("Conversation session not found.");

  const { data, error } = await supabase
    .from("chat_turns")
    .select("id, question, answer, citations, abstained")
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .neq("id", currentTurnId)
    .order("created_at", { ascending: false })
    .limit(3);
  if (error) throw new Error(`Could not load conversation history: ${error.message}`);

  const turns = data || [];
  const retrievalScores = new Map<string, number | null>();
  if (turns.length) {
    const { data: feedback, error: feedbackError } = await supabase
      .from("turn_feedback")
      .select("turn_id, retrieval_match_percent")
      .eq("user_id", userId)
      .in("turn_id", turns.map((turn) => turn.id));
    if (feedbackError) {
      console.warn("Could not load retrieval estimates for conversation context", feedbackError.message);
    } else {
      for (const entry of feedback || []) {
        retrievalScores.set(entry.turn_id, entry.retrieval_match_percent);
      }
    }
  }

  return turns.reverse().map((turn) => ({
    question: turn.question,
    answer: turn.answer,
    citations: z.array(conversationCitationSchema).parse(turn.citations),
    abstained: turn.abstained,
    retrievalMatchPercent: retrievalScores.get(turn.id) ?? null,
  }));
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
  const user = await getRequestUser(request);
  if (!user) {
    return NextResponse.json({ error: "Sign in to chat with your documents." }, { status: 401 });
  }

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
    const turnId = parsed.data.turnId || randomUUID();
    return createEventStream(async (emit) => {
      const response = await answerQuestion(parsed.data.message, user.id, turnId, parsed.data.sessionId, {
        onStatus: (status) => emit("status", { status }),
        onToken: (text) => emit("token", { text }),
      }, parsed.data.documentId);
      emit("final", response);
    });
  }

  try {
    const response = await answerQuestion(
      parsed.data.message,
      user.id,
      parsed.data.turnId || randomUUID(),
      parsed.data.sessionId,
      undefined,
      parsed.data.documentId,
    );
    return NextResponse.json(response);
  } catch (error) {
    console.error("Chat request failed", error);
    return NextResponse.json(
      { error: "The assistant is temporarily unavailable. Check the server configuration and try again." },
      { status: 503 },
    );
  }
}
