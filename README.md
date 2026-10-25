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

The repository deploys as a single Next.js app. `vercel.json` selects the Next.js framework; Vercel’s default npm install and `next build` are used. The Python Docling CLI is **not** deployed as a Vercel service: run it locally when indexing documents.

### Before the first deployment

1. Create a Supabase project and a Cloudflare API token with Workers AI permission.
2. In Supabase SQL Editor, apply `supabase/migrations/202610250001_initial_schema.sql`, then `supabase/migrations/202610250002_chat_response_cache.sql`.
3. Index the sample corpus from your local machine. Follow [Index the sample corpus](#index-the-sample-corpus-explicit-local-action) below and run the command without `--dry-run`. Verify the documents appear after deployment through `/api/documents`.
4. Push this repository to GitHub and import it in Vercel. Set the Vercel project **Root Directory** to the repository root (not `ingestion`). Leave the framework, install command, build command, and output directory on their detected/default settings.
5. Set the Node.js version to 20.9 or newer, matching `package.json`.
6. In Vercel Project Settings → Environment Variables, add these **server-side** values for Production and any Preview/Development environments you intend to use:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_API_TOKEN`
7. Optionally set the model/cache overrides from `.env.example`: `CF_EMBEDDING_MODEL`, `CF_EMBEDDING_DIMENSIONS`, `CF_PRIMARY_TEXT_MODEL`, `CF_FALLBACK_TEXT_MODEL`, `RETRIEVAL_MIN_SCORE`, and `CHAT_CACHE_TTL_SECONDS`. Defaults are listed there. Never add a `NEXT_PUBLIC_` prefix to secrets.
8. Deploy. Redeploy after changing Vercel environment variables.
9. Smoke-test the deployment: open `/`, then `/api/documents` and confirm the indexed files are listed. Ask a question whose answer exists in the sample corpus and confirm the response includes citations.

The chat and document API routes explicitly use the Node.js runtime. Chat requests have a 30-second maximum duration. Vercel cannot apply database migrations or ingest local files as part of the Next.js build. The service-role key and Cloudflare token must stay server-side. A Vercel deployment does not automatically create Supabase/Cloudflare accounts, configure secrets, or populate the index.

## Checks

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
python -m unittest discover -s ingestion/tests
```

The automated tests cover citation formatting, model fallback policy, and ingestion text/table transformations. Provider, database, and full UI end-to-end checks require valid external service credentials and an indexed corpus.
