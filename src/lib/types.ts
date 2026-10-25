export type Citation = {
  id: string;
  filename: string;
  documentType: "pdf" | "docx" | "xlsx";
  location: Record<string, unknown>;
  excerpt: string;
  kind: "chunk" | "fact";
};

export type ChatResponse = {
  answer: string;
  citations: Citation[];
  abstained: boolean;
  provider?: "cloudflare-primary" | "cloudflare-fallback";
};

export type IndexedDocument = {
  id: string;
  filename: string;
  documentType: "pdf" | "docx" | "xlsx";
  indexedAt: string;
  chunkCount: number;
  factCount: number;
};

export type RetrievedRecord = {
  result_id: string;
  result_kind: "chunk" | "fact";
  content: string;
  source_filename: string;
  source_type: "pdf" | "docx" | "xlsx";
  source_location: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  score: number;
};
