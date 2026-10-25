import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/retrieval";

export const runtime = "nodejs";

type RelatedCount = number | { count: number } | Array<{ count: number }> | null;

type DocumentRow = {
  id: string;
  filename: string;
  document_type: "pdf" | "docx" | "xlsx";
  indexed_at: string;
  document_chunks: RelatedCount;
  structured_facts: RelatedCount;
};

function relatedCount(value: RelatedCount): number {
  if (typeof value === "number") return value;
  const item = Array.isArray(value) ? value[0] : value;
  return item && typeof item.count === "number" ? item.count : 0;
}

export async function GET() {
  try {
    const { data, error } = await getSupabase()
      .from("documents")
      .select("id, filename, document_type, indexed_at, document_chunks(count), structured_facts(count)")
      .order("filename", { ascending: true });

    if (error) throw new Error(`Supabase document listing failed: ${error.message}`);

    const documents = ((data || []) as unknown as DocumentRow[]).map((document) => ({
      id: document.id,
      filename: document.filename,
      documentType: document.document_type,
      indexedAt: document.indexed_at,
      chunkCount: relatedCount(document.document_chunks),
      factCount: relatedCount(document.structured_facts),
    }));

    return NextResponse.json({ documents, total: documents.length });
  } catch (error) {
    console.error("Document listing failed", error);
    return NextResponse.json(
      { error: "Could not load indexed documents. Check the Supabase configuration and migration." },
      { status: 503 },
    );
  }
}
