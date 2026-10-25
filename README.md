# Silverline source-grounded assistant

This repository implements the approved public chat MVP for the **illustrative Silverline corpus**. Silverline and every supplied file are fictional training samples. They are not real company information, approved records, filings, or professional advice.

## Architecture

- `src/app/`: Next.js App Router chat UI and `/api/chat` Route Handler (no separate API service).
- `src/lib/`: Cloudflare Workers AI embeddings, Supabase hybrid retrieval, and two Cloudflare-hosted Workers AI text models with transient-failure fallback.
- `supabase/migrations/`: Postgres schema, pgvector/full-text indexes, atomic idempotent document replacement, hybrid chunk/fact search, and the server-side chat response cache.
- `ingestion/`: Python Docling indexing CLI; spreadsheet facts additionally retain sheet/row/cell coordinates.
- `docs/`: the supplied local sample corpus. Files are not sent anywhere by this project until you explicitly run the ingestion CLI.

## Prerequisites

- Node.js 20.9+ and npm.
- Python 3.10+ for local ingestion (Docling can need platform-specific system libraries and model downloads).
- A Supabase project with SQL Editor or Supabase CLI access.
- A Cloudflare account/API token with Workers AI access.

No credentials are committed. Copy `.env.example` to `.env.local` for the web application and set actual values only in your local secret store. The ingestion CLI also loads the repository-root `.env.local`; variables already set in the shell take precedence. The service-role key must remain server-side; do not prefix it with `NEXT_PUBLIC_`.

## Database setup

1. Create a Supabase project.
2. Apply the SQL migrations in `supabase/migrations/` in filename order in the Supabase SQL Editor. To use Supabase CLI instead, initialize/link the CLI project first, then run `supabase db push`.
3. The migration pins `extensions.vector(768)`. The default `@cf/baai/bge-base-en-v1.5` model returns 768 dimensions. If changing model or dimension, update `CF_EMBEDDING_DIMENSIONS` consistently **and** alter the migration's vector columns, function signature, and index before applying it.
4. The tables have RLS enabled and no public policies. Only the Next.js server and ingestion CLI use the service-role key.

## Run the web app locally

```powershell
Copy-Item .env.example .env.local
npm.cmd install
npm.cmd run dev
```

Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN` in `.env.local`. Optional model settings are `CF_EMBEDDING_MODEL`, `CF_EMBEDDING_DIMENSIONS`, `CF_PRIMARY_TEXT_MODEL` (default `@cf/qwen/qwen3-30b-a3b-fp8`), `CF_FALLBACK_TEXT_MODEL` (default `@cf/meta/llama-3.2-3b-instruct`), and `RETRIEVAL_MIN_SCORE`. These are Cloudflare-hosted models accessed through Workers AI; you do not need to run model servers yourself. Open the URL printed by Next.js (normally `http://localhost:3000`).

`POST /api/chat` accepts `{ "message": "..." }` (1–2000 characters) and returns `{ answer, citations, abstained, provider? }`. The route checks the Supabase response cache first; on a miss, it embeds the question, calls the `hybrid_search` database function, abstains if no results meet the configured relevance threshold, then calls the primary Cloudflare Workers AI model. It uses the fallback Cloudflare model only if the primary fails transiently (HTTP 429/5xx, network failure, or timeout). Successful answers are cached for 24 hours by default; `CHAT_CACHE_TTL_SECONDS` changes the TTL. Cache keys include a normalized question, a revision derived from indexed document checksums and names, and the retrieval/model configuration. Consequently, document re-indexing that changes corpus content or a model/prompt configuration change naturally causes a cache miss. Cache read/write failures are logged and do not prevent a fresh answer. Cloudflare Workers AI has a daily free allocation; usage above the allowance may require a paid Workers plan. Check the current [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) for details.

## Index the sample corpus (explicit local action)

The CLI does not run during web requests. Run it only when you intend to send the selected `docs/` contents to your Supabase database and Cloudflare Workers AI for indexing/embedding.

```powershell
python -m venv ingestion/.venv
ingestion/.venv/Scripts/python -m pip install -r ingestion/requirements.txt
ingestion/.venv/Scripts/python ingestion/indexer.py --docs-dir docs --dry-run
```

For actual indexing, make sure the repository-root `.env.local` contains the Supabase and Cloudflare credentials, then omit `--dry-run`:

```powershell
ingestion/.venv/Scripts/python ingestion/indexer.py --docs-dir docs
```

The CLI uses Docling to parse PDF, DOCX, and XLSX and records page/section/table context where available. Workbook facts include metric, scope, period, units, value, and sheet/row/cell coordinates where extractable. Formula cells with missing cached values are reported as unavailable and never coerced to zero. A content checksum is stored and each source path is replaced atomically, so reruns do not duplicate chunks/facts. Source documents themselves are not uploaded.

## Deploy to Vercel

1. Push this repository to GitHub and import it into Vercel. Keep the project root set to the repository root; Vercel should detect Next.js automatically. No custom `vercel.json`, build command, output directory, or install command is required.
2. Use Node.js 20.9 or newer (the supported range is declared in `package.json`). Keep the package manager set to npm so Vercel uses the committed `package-lock.json`.
3. Add these **server-side** environment variables in Vercel Project Settings → Environment Variables for every environment that should run the app (Production, and Preview if needed):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_API_TOKEN`
4. Optional overrides are `CF_EMBEDDING_MODEL`, `CF_EMBEDDING_DIMENSIONS`, `CF_PRIMARY_TEXT_MODEL`, `CF_FALLBACK_TEXT_MODEL`, `RETRIEVAL_MIN_SCORE`, and `CHAT_CACHE_TTL_SECONDS`. Defaults are documented in `.env.example`. Do not add a `NEXT_PUBLIC_` prefix to secrets.
5. Before using the deployment, apply `202610250001_initial_schema.sql` and then `202610250002_chat_response_cache.sql` to the Supabase project. Run the Docling ingestion CLI locally to index the documents; Vercel does not run ingestion as part of the build.
6. Redeploy after changing Vercel environment variables. Verify `/` and `/api/documents`; chat answers additionally require the migrations, indexed documents, and valid Cloudflare Workers AI credentials.

The chat and document API routes explicitly use the Node.js runtime. Chat requests have a 30-second maximum duration. Deploying this code does not itself configure external credentials, apply database migrations, ingest documents, or perform a Vercel deployment.

## Checks

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
python -m unittest discover -s ingestion/tests
```

The automated tests cover citation formatting, model fallback policy, and ingestion text/table transformations. Provider, database, and full UI end-to-end checks require valid external service credentials and an indexed corpus.
