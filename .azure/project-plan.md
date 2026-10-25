# Silverline Board & Financial Results RAG Assistant

## Goal

Build a public, source-grounded chatbot for the illustrative PDF, DOCX, and XLSX documents in `docs/`. The application must clearly communicate that the Silverline company and its records are fictional training samples, not real company information, approved records, filings, or professional advice.

## Approved scope

- Customizable, responsive chat interface built with Next.js, React, and TypeScript.
- Public access for the MVP; no sign-in.
- Next.js Route Handlers provide the chat API; do not add a separate FastAPI service.
- Deploy the web application to Vercel.
- Use Supabase Postgres with pgvector and full-text search for document chunks, metadata, embeddings, and structured spreadsheet facts.
- Use Docling in a separate Python CLI/job to extract and index the supplied PDF, DOCX, and XLSX documents. Do not parse or bulk-index documents in a chat request.
- Use an open-weight embedding model through Cloudflare Workers AI for both indexing and query embeddings. Keep the model ID and embedding dimensions configurable and consistent.
- Use Gemini Flash as the primary answer-generation provider and Cloudflare Workers AI text generation as fallback for transient primary-provider failures.
- Return answers grounded in retrieved material with precise citations and abstain when the indexed corpus does not support an answer.

## Ingestion and retrieval requirements

- Preserve source identity and location metadata: filename, document type, PDF page, DOCX section/table, and XLSX sheet/row/cell context when available.
- Extract narrative material into heading-aware chunks and keep table rows with their labels and headers.
- Store spreadsheet facts with their metric, scope (standalone/consolidated), period, units, value, and source location. Do not treat blank cached formula results as zero; validate or report unavailable derived values.
- Use hybrid retrieval: vector similarity plus Postgres full-text search. Include structured fact lookup for numeric questions.
- Keep indexing repeatable and idempotent so rerunning the CLI updates existing document versions without duplicate chunks.

## Initial implementation deliverables

1. Next.js application with a polished chat page, citations/source panel, loading/error states, and fictional-data notice.
2. Server-side chat route with request validation, hybrid retrieval, Gemini-first generation, limited fallback handling, and cited response shape.
3. Supabase SQL migration for documents, chunks, structured facts, vector/full-text indexes, and search functions.
4. Python Docling ingestion CLI and dependency manifest for the existing `docs/` corpus.
5. Environment-variable example and setup/deployment instructions for Supabase, Gemini, Cloudflare Workers AI, local ingestion, and Vercel.
6. Focused tests for ingestion transformations, search/response formatting, and provider fallback behavior where practical.

## Non-goals

- Authentication, user accounts, or private per-user workspaces.
- User document uploads or automated background job infrastructure in the MVP.
- Legal, accounting, investment, or regulatory advice.
- Treating illustrative material as factual evidence about a real company.
