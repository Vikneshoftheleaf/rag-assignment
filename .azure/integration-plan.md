# Integration hand-off

- **Backend/API**: workspace root; Next.js Route Handler `src/app/api/chat/route.ts`; run `npm run dev`; port `3000`; build `npm run build`; health: `GET /` (chat UI), `POST /api/chat`.
- **Frontend**: workspace root; build `npm run build`; dev `npm run dev`; API seam `src/app/page.tsx` `ask()` fetch to `/api/chat`; no mock client or mock datasets.
- **API routes**: `POST /api/chat` — JSON `{ "message": string }`; returns `{ answer, citations, abstained, provider? }`; malformed/invalid input `400`, service errors `503`.
- **Database**: Supabase Postgres + pgvector; migration `supabase/migrations/202610250001_initial_schema.sql`; schema contains `documents`, `document_chunks`, `structured_facts`, and functions `replace_document_index`, `hybrid_search`; connection env `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; use SQL migration, no seed data.
- **Ingestion**: Python CLI `ingestion/indexer.py`; command `python ingestion/indexer.py --docs-dir docs`; dependencies `ingestion/requirements.txt`; Cloudflare model envs `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CF_EMBEDDING_MODEL`, `CF_EMBEDDING_DIMENSIONS`.
- **Frontend/API env**: `GEMINI_API_KEY`, `GEMINI_MODEL`, `CF_TEXT_MODEL`, `RETRIEVAL_MIN_SCORE`; see `.env.example`.
- **Shared types**: `src/lib/types.ts`; frontend import alias `@/lib/types`.
- **Mock cleanup**: no mock API client, mock datasets, duplicated local model types, or preview-state switcher were scaffolded.
- **Services**: Chat interface (Essential); Next.js chat orchestration API (Essential); Docling ingestion CLI (Essential); Supabase Postgres/pgvector (Essential); Gemini Flash generation (Essential); Cloudflare Workers AI embeddings and fallback generation (Essential).
