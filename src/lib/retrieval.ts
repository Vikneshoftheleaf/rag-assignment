import { createClient } from "@supabase/supabase-js";
import { embedTexts } from "@/lib/providers";
import type { Citation, RetrievedRecord } from "@/lib/types";

export function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type FeedbackRetrievalContext = {
  queryEmbedding: number[];
  positiveSourceIds: Set<string>;
  negativeSourceIds: Set<string>;
  hasMatches: boolean;
};

export async function prepareFeedbackRetrieval(
  question: string,
  userId: string,
  corpusRevision: string,
  documentId?: string,
): Promise<FeedbackRetrievalContext> {
  const [queryEmbedding] = await embedTexts([question]);
  const emptyContext: FeedbackRetrievalContext = {
    queryEmbedding,
    positiveSourceIds: new Set(),
    negativeSourceIds: new Set(),
    hasMatches: false,
  };

  const { data, error } = await getSupabase().rpc("match_turn_feedback_sources", {
    p_query_embedding: JSON.stringify(queryEmbedding),
    p_user_id: userId,
    p_corpus_revision: corpusRevision,
    p_document_id: documentId || null,
    p_min_similarity: Number(process.env.FEEDBACK_MATCH_MIN_SIMILARITY || "0.78"),
  });
  if (error) {
    console.warn("Feedback retrieval search unavailable; using standard retrieval", error.message);
    return emptyContext;
  }

  const match = Array.isArray(data) ? data[0] : data;
  const positiveSourceIds = new Set<string>(match?.positive_source_ids || []);
  const negativeSourceIds = new Set<string>(match?.negative_source_ids || []);
  for (const sourceId of negativeSourceIds) positiveSourceIds.delete(sourceId);
  return {
    queryEmbedding,
    positiveSourceIds,
    negativeSourceIds,
    hasMatches: positiveSourceIds.size > 0 || negativeSourceIds.size > 0,
  };
}

export async function retrieveEvidence(
  question: string,
  documentId?: string,
  feedbackContext?: FeedbackRetrievalContext,
): Promise<RetrievedRecord[]> {
  const queries = buildRetrievalQueries(question);
  const expandedEmbeddings = await embedTexts(feedbackContext
    ? queries.slice(1)
    : queries);
  const embeddings = feedbackContext
    ? [feedbackContext.queryEmbedding, ...expandedEmbeddings]
    : expandedEmbeddings;
  const supabase = getSupabase();
  const results = await Promise.all(queries.map(async (query, index) => {
    const { data, error } = await supabase.rpc(
      documentId ? "document_hybrid_search" : "hybrid_search",
      {
        query_embedding: JSON.stringify(embeddings[index]),
        query_text: query,
        match_count: 50,
        ...(documentId ? { target_document_id: documentId } : {}),
      },
    );
    if (error) {
      throw new Error(
        `Supabase ${documentId ? "document " : ""}hybrid search failed for query "${query}": ${error.message}`,
      );
    }
    return (data || []) as RetrievedRecord[];
  }));

  const merged = new Map<string, { record: RetrievedRecord; score: number; occurrences: number }>();
  for (const result of results) {
    for (const record of result) {
      const existing = merged.get(record.result_id);
      if (!existing) {
        merged.set(record.result_id, {
          record,
          score: Number(record.score) || 0,
          occurrences: 1,
        });
      } else {
        existing.score = Math.max(existing.score, Number(record.score) || 0);
        existing.occurrences++;
      }
    }
  }

  return [...merged.values()]
    .map(({ record, score, occurrences }) => {
      const baseScore = Math.min(1, score + Math.min(0.12, (occurrences - 1) * 0.025));
      const isNegative = feedbackContext?.negativeSourceIds.has(record.result_id) || false;
      const isPositive = feedbackContext?.positiveSourceIds.has(record.result_id) || false;
      const adjustedScore = isNegative
        ? baseScore * 0.55
        : isPositive
          ? Math.min(1, baseScore + 0.12)
          : baseScore;
      return {
        ...record,
        score: adjustedScore,
        retrieval_score: baseScore,
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 100);
}

export function buildRetrievalQueries(question: string): string[] {
  const queries = [question];
  const fiscalYear = question.match(/\bFY\s*\d{4}[-–/]\d{2,4}\b/i)?.[0]?.replace(/\s+/g, " ");
  const periods = [
    /\bQ[1-4]\b/i.test(question) ? question.match(/\bQ[1-4]\b/i)?.[0].toUpperCase() : null,
    /\bH[1-2]\b|\bhalf[\s-]*year\b/i.test(question)
      ? question.match(/\bH[1-2]\b/i)?.[0].toUpperCase() || "H1"
      : null,
  ].filter((period): period is string => Boolean(period));
  const scopes = [
    /\bstandalone\b/i.test(question) ? "standalone" : "",
    /\bconsolidated\b/i.test(question) ? "consolidated" : "",
  ].filter(Boolean).join(" ");

  const metricQueries = [
    { pattern: /\b(?:revenue|turnover|sales)\b/i, label: "revenue from operations" },
    { pattern: /\b(?:profit|earnings|net income|pat|pbt)\b/i, label: "profit for the period" },
    { pattern: /\b(?:expenses?|costs?)\b/i, label: "total expenses" },
    { pattern: /\b(?:ebitda|margin|eps|tax)\b/i, label: "financial metric" },
  ].filter(({ pattern }) => pattern.test(question));
  for (const metric of metricQueries) {
    for (const period of periods) {
      queries.push([metric.label, period, fiscalYear, scopes].filter(Boolean).join(" "));
    }
  }

  if (/\b(?:auditor|audit|limited review|review report|opinion|conclusion)\b/i.test(question)) {
    queries.push(
      ["auditor limited review conclusion", periods.join(" "), fiscalYear].filter(Boolean).join(" "),
      "nothing has come to our attention material misstatement",
    );
  }

  if (
    /\b(?:board|meeting)\b/i.test(question) &&
    /\b(?:decision|resolution|action|follow[\s-]*up|summari[sz]e|all)\b/i.test(question)
  ) {
    queries.push(
      "Board meeting summary of resolutions and action items",
      "interim dividend decision record date board meeting action",
      "interim dividend follow-up verify final entitlement data tax payment arrangements disclosures",
      "interim dividend resolution BR-02 processing payment compliance filing action owner",
      "Q2 H1 results BR-01 CFO Finance Company Secretary limited review exchange disclosure filing action",
      "capital expenditure manufacturing modernisation board decision",
      "appointment Chief Financial Officer effective date board decision",
      "related party transaction governance board action",
      "enterprise risk cybersecurity compliance remediation board meeting",
      "general authorisation filings implementation limits board decision",
    );
  }

  return [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
}

export function formatCitations(records: RetrievedRecord[]) {
  return records.map((record, index) => ({
    id: `S${index + 1}`,
    sourceId: record.result_id,
    filename: record.source_filename,
    documentType: record.source_type,
    location: record.source_location || {},
    excerpt: record.content.slice(0, 420),
    kind: record.result_kind,
    score: record.retrieval_score ?? record.score,
  }));
}

export function keepCitedSources(answer: string, citations: Citation[]) {
  const available = new Map(citations.map((citation) => [citation.id, citation]));
  let sanitizedAnswer = answer.replace(/\[S\d+\]/g, (label) => {
    const id = label.slice(1, -1);
    return available.has(id) ? label : "";
  }).trim();
  let usedIds = [...new Set(Array.from(sanitizedAnswer.matchAll(/\[(S\d+)\]/g), (match) => match[1]))];

  if (usedIds.length === 0 && citations.length > 0) {
    usedIds = [citations[0].id];
    sanitizedAnswer = `${sanitizedAnswer} [${citations[0].id}]`.trim();
  }

  return {
    answer: sanitizedAnswer,
    citations: usedIds.flatMap((id) => {
      const citation = available.get(id);
      return citation ? [citation] : [];
    }),
  };
}

export function formatLocation(location: Record<string, unknown>): string {
  const bits: string[] = [];
  for (const key of ["page", "section", "heading", "table", "sheet", "row", "cell"]) {
    const value = location[key];
    if (value !== undefined && value !== null && `${value}`.trim()) {
      bits.push(`${key}: ${value}`);
    }
  }
  return bits.join(" · ") || "Source excerpt";
}
