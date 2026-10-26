import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ChatResponse } from "@/lib/types";

const cacheResponseSchema = z.object({
  answer: z.string(),
  citations: z.array(z.object({
    id: z.string(),
    sourceId: z.string().optional(),
    filename: z.string(),
    documentType: z.enum(["pdf", "docx", "xlsx"]),
    location: z.record(z.string(), z.unknown()),
    excerpt: z.string(),
    kind: z.enum(["chunk", "fact"]),
    score: z.number(),
  })),
  abstained: z.boolean(),
  provider: z.enum(["cloudflare-primary", "cloudflare-fallback"]).optional(),
  retrievalMatchPercent: z.number().nullable().optional(),
});

const cacheConfigurationVersion = "chat-response-v11";
const cacheConflictTarget = "question_key, corpus_revision, configuration_hash";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildQuestionKey(question: string): string {
  return sha256(question.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US"));
}

export function buildCacheConfigurationHash(): string {
  return sha256(JSON.stringify({
    cacheConfigurationVersion,
    promptVersion: "grounded-prompt-v10",
    retrievalVersion: "conversation-aware-evidence-v10",
    feedbackMatchSimilarity: process.env.FEEDBACK_MATCH_MIN_SIMILARITY || "0.78",
    responseMaxTokens: 1600,
    minimumRelevance: process.env.RETRIEVAL_MIN_SCORE || "0.18",
    embeddingModel: process.env.CF_EMBEDDING_MODEL || "@cf/baai/bge-base-en-v1.5",
    embeddingDimensions: process.env.CF_EMBEDDING_DIMENSIONS || "768",
    primaryModel: process.env.CF_PRIMARY_TEXT_MODEL || "@cf/openai/gpt-oss-120b",
    fallbackModel: process.env.CF_FALLBACK_TEXT_MODEL || "@cf/openai/gpt-oss-20b",
  }));
}

export async function getCorpusRevision(client: SupabaseClient): Promise<string> {
  const { data, error } = await client
    .from("documents")
    .select("source_path, filename, document_type, checksum")
    .order("source_path", { ascending: true });
  if (error) throw new Error(`Could not determine indexed corpus revision: ${error.message}`);

  return sha256(JSON.stringify(data || []));
}

export async function readCachedResponse(
  client: SupabaseClient,
  questionKey: string,
  corpusRevision: string,
  configurationHash: string,
): Promise<ChatResponse | null> {
  const { data, error } = await client
    .from("chat_response_cache")
    .select("response")
    .eq("question_key", questionKey)
    .eq("corpus_revision", corpusRevision)
    .eq("configuration_hash", configurationHash)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error) throw new Error(`Supabase chat cache lookup failed: ${error.message}`);
  if (!data) return null;

  const parsed = cacheResponseSchema.safeParse(data.response);
  if (!parsed.success) {
    console.error("Supabase chat cache entry is invalid and will be regenerated", parsed.error);
    return null;
  }
  return parsed.data;
}

export async function writeCachedResponse(
  client: SupabaseClient,
  questionKey: string,
  corpusRevision: string,
  configurationHash: string,
  response: ChatResponse,
): Promise<void> {
  const ttlSeconds = Number(process.env.CHAT_CACHE_TTL_SECONDS || "86400");
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error("CHAT_CACHE_TTL_SECONDS must be a positive integer.");
  }

  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const cacheableResponse: ChatResponse = {
    answer: response.answer,
    citations: response.citations,
    abstained: response.abstained,
    provider: response.provider,
    retrievalMatchPercent: response.retrievalMatchPercent,
  };
  const { error } = await client
    .from("chat_response_cache")
    .upsert({
      question_key: questionKey,
      corpus_revision: corpusRevision,
      configuration_hash: configurationHash,
      response: cacheableResponse,
      expires_at: expiresAt,
    }, { onConflict: cacheConflictTarget });

  if (error) throw new Error(`Supabase chat cache write failed: ${error.message}`);
}
