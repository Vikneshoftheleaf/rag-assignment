import type { SupabaseClient } from "@supabase/supabase-js";
import type { RetrievedRecord } from "@/lib/types";

export type TurnFeedbackSource = {
  sourceId: string;
  kind: "chunk" | "fact";
  content: string;
  filename: string;
  location: Record<string, unknown>;
  score: number;
};

export type FeedbackStats = {
  positiveCount: number;
  negativeCount: number;
  approvalPercent: number | null;
};

export function toFeedbackSources(records: RetrievedRecord[]): TurnFeedbackSource[] {
  return records.map((record) => ({
    sourceId: record.result_id,
    kind: record.result_kind,
    content: record.content,
    filename: record.source_filename,
    location: record.source_location || {},
    score: record.retrieval_score ?? record.score,
  }));
}

export function getRetrievalMatchPercent(
  records: Array<{ score: number; retrieval_score?: number }>,
): number | null {
  if (records.length === 0) return null;
  const scores = records
    .map((record) => Math.max(0, Math.min(1, record.retrieval_score ?? record.score)))
    .sort((left, right) => right - left)
    .slice(0, 5);
  return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length * 100);
}

export async function getFeedbackStats(
  client: SupabaseClient,
  userId: string,
): Promise<FeedbackStats> {
  const { data, error } = await client.rpc("get_turn_feedback_stats", {
    p_user_id: userId,
  });
  if (error) throw new Error(`Could not load feedback statistics: ${error.message}`);

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { positiveCount: 0, negativeCount: 0, approvalPercent: null };
  return {
    positiveCount: Number(row.positive_count) || 0,
    negativeCount: Number(row.negative_count) || 0,
    approvalPercent: row.approval_percent === null ? null : Number(row.approval_percent),
  };
}

export async function recordTurnFeedback(
  client: SupabaseClient,
  input: {
    turnId: string;
    userId: string;
    documentId?: string;
    question: string;
    answer: string;
    sources: TurnFeedbackSource[];
    queryEmbedding: number[];
    corpusRevision: string;
    retrievalMatchPercent: number | null;
  },
): Promise<string> {
  const { data, error } = await client.rpc("record_turn_feedback", {
    p_turn_id: input.turnId,
    p_user_id: input.userId,
    p_document_id: input.documentId || null,
    p_query_text: input.question,
    p_answer_text: input.answer,
    p_sources: input.sources,
    p_query_embedding: JSON.stringify(input.queryEmbedding),
    p_corpus_revision: input.corpusRevision,
    p_retrieval_match_percent: input.retrievalMatchPercent,
  });
  if (error) throw new Error(`Could not store answer feedback context: ${error.message}`);
  if (typeof data !== "string") throw new Error("Feedback storage returned an invalid record id.");
  return data;
}

export async function updateTurnFeedback(
  client: SupabaseClient,
  userId: string,
  turnId: string,
  vote: -1 | 1,
): Promise<void> {
  const { data, error } = await client
    .from("turn_feedback")
    .update({ vote, rated_at: new Date().toISOString() })
    .eq("turn_id", turnId)
    .eq("user_id", userId)
    .select("turn_id")
    .maybeSingle();
  if (error) throw new Error(`Could not save answer feedback: ${error.message}`);
  if (!data) throw new Error("Feedback record not found.");
}
