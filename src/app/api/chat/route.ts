import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildCacheConfigurationHash,
  buildQuestionKey,
  getCorpusRevision,
  readCachedResponse,
  writeCachedResponse,
} from "@/lib/chat-cache";
import { generateWithFallback } from "@/lib/providers";
import { formatCitations, getSupabase, keepCitedSources, retrieveEvidence } from "@/lib/retrieval";
import { buildGroundedPrompt } from "@/lib/prompt";
import type { ChatResponse } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

const requestSchema = z.object({
  message: z.string().trim().min(1).max(2000),
});

const MIN_RELEVANCE = Number(process.env.RETRIEVAL_MIN_SCORE || "0.18");

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

  try {
    const supabase = getSupabase();
    const questionKey = buildQuestionKey(parsed.data.message);
    const corpusRevision = await getCorpusRevision(supabase);
    const configurationHash = buildCacheConfigurationHash();
    try {
      const cached = await readCachedResponse(supabase, questionKey, corpusRevision, configurationHash);
      if (cached) return NextResponse.json(cached);
    } catch (error) {
      console.error("Chat cache read failed; continuing without cache", error);
    }

    const retrieved = await retrieveEvidence(parsed.data.message);
    const selected = retrieved.filter((record) => Number(record.score) >= MIN_RELEVANCE).slice(0, 6);
    if (!selected.length) {
      return NextResponse.json({
        answer: "I couldn’t find enough supporting information in the indexed Silverline sample documents to answer that.",
        citations: [],
        abstained: true,
      });
    }
    const result = await generateWithFallback(buildGroundedPrompt(parsed.data.message, selected));
    const cited = keepCitedSources(result.text, formatCitations(selected));
    const response: ChatResponse = {
      answer: cited.answer,
      citations: cited.citations,
      abstained: false,
      provider: result.provider,
    };
    try {
      await writeCachedResponse(supabase, questionKey, corpusRevision, configurationHash, response);
    } catch (error) {
      console.error("Chat cache write failed; returning generated answer", error);
    }
    return NextResponse.json(response);
  } catch (error) {
    console.error("Chat request failed", error);
    return NextResponse.json(
      { error: "The assistant is temporarily unavailable. Check the server configuration and try again." },
      { status: 503 },
    );
  }
}
