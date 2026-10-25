import { createClient } from "@supabase/supabase-js";
import { embedText } from "@/lib/providers";
import type { RetrievedRecord } from "@/lib/types";

export function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function retrieveEvidence(
  question: string,
  documentId?: string,
): Promise<RetrievedRecord[]> {
  const embedding = await embedText(question);
  const { data, error } = await getSupabase().rpc(documentId ? "document_hybrid_search" : "hybrid_search", {
    query_embedding: JSON.stringify(embedding),
    query_text: question,
    match_count: 20,
    ...(documentId ? { target_document_id: documentId } : {}),
  });
  if (error) throw new Error(`Supabase ${documentId ? "document " : ""}hybrid search failed: ${error.message}`);
  return (data || []) as RetrievedRecord[];
}

export function formatCitations(records: RetrievedRecord[]) {
  return records.map((record, index) => ({
    id: `S${index + 1}`,
    filename: record.source_filename,
    documentType: record.source_type,
    location: record.source_location || {},
    excerpt: record.content.slice(0, 420),
    kind: record.result_kind,
  }));
}

export function keepCitedSources(answer: string, citations: ReturnType<typeof formatCitations>) {
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
