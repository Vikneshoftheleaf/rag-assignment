# Silverline source-grounded assistant

This repository implements the approved public chat MVP for the **illustrative Silverline corpus**. Silverline and every supplied file are fictional training samples. They are not real company information, approved records, filings, or professional advice.

## Architecture

- `src/app/`: Next.js App Router chat UI, `/api/chat`, and a Cloudflare Workers AI transcription Route Handler (no separate API service).
- `src/lib/`: Supabase Auth client, Cloudflare Workers AI embeddings, transcription and text models, Supabase hybrid retrieval, and provider fallback.
- `supabase/migrations/`: Postgres schema, pgvector/full-text indexes, atomic idempotent document replacement, corpus-wide and document-scoped hybrid search, server-side chat response cache, and owner-scoped conversation history.
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
2. Apply all SQL migrations in `supabase/migrations/` in filename order in the Supabase SQL Editor. This includes the document-scoped search function used to summarize a selected file and private chat history tables. To use Supabase CLI instead, initialize/link the CLI project first, then run `supabase db push`.
3. The migration pins `extensions.vector(768)`. The default `@cf/baai/bge-base-en-v1.5` model returns 768 dimensions. If changing model or dimension, update `CF_EMBEDDING_DIMENSIONS` consistently **and** alter the migration's vector columns, function signature, and index before applying it.
4. The tables have RLS enabled and no public policies. Only the Next.js server and ingestion CLI use the service-role key.

## Run the web app locally

```powershell
Copy-Item .env.example .env.local
npm.cmd install
npm.cmd run dev
```

Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN` in `.env.local`. The public Supabase URL and anon key are used by the browser auth client; the service-role key must remain server-only. Answer generation defaults to Cloudflare-hosted OpenAI GPT-OSS 120B, with GPT-OSS 20B as its transient-failure fallback. The 120B model is the quality-first primary; 20B is a lower-latency backup. Both are served by Workers AI, so you do not run model servers yourself. Cloudflare lists GPT-OSS 120B at $0.35 per million input tokens and $0.75 per million output tokens, and GPT-OSS 20B at $0.20 per million input tokens and $0.30 per million output tokens at the time of writing. "Open-weight" means the model weights are available; inference through Cloudflare is usage-priced and is not necessarily free. Set `CF_PRIMARY_TEXT_MODEL` or `CF_FALLBACK_TEXT_MODEL` to override these defaults; environment variables already configured in Vercel take precedence over `.env.example`. Speech recognition uses Cloudflare Workers AI Whisper Large v3 Turbo with Whisper as a transient-failure fallback. Open the URL printed by Next.js (normally `http://localhost:3000`).

### Accounts and saved chats

- Sign-up and sign-in use Supabase Auth with email/password or Google OAuth. Supabase Auth persists the browser session across reloads. Email/password accounts are created without an in-app verification gate; if Supabase project settings require email confirmation, users must still complete that provider-level setting.
- Enable Google in Supabase **Authentication → Providers**, configure OAuth credentials, and add the local and production app URLs to **Authentication → URL Configuration → Redirect URLs**. Use the callback URL shown by Supabase's Google provider settings for the Google Cloud OAuth client.
- Apply the `202610260001_chat_sessions.sql` migration. Chat sessions and turns are linked to `auth.users`, protected by row-level security, and accessed through authenticated API routes. Users can revisit, rename, and delete their own sessions. Sign-out clears the current in-memory workspace; saved conversations remain attached to the account.
- The app verifies each bearer token with Supabase Auth before serving chat, document-list, transcription, or conversation-history APIs. Configure the public Supabase URL/anon key and server-side service-role key in local and Vercel environments.

### Voice features

- Use the microphone control in the composer to record a question. The browser requests microphone permission, applies supported noise/echo cancellation, and stops automatically after 60 seconds. The transcript is inserted into the editable question field; it is not sent until you press Send.
- Recordings are limited to 2 MB and supported browser formats (WebM, Ogg, MP4, WAV, or AAC). Transcription is handled server-side, so Cloudflare credentials are never exposed to the browser.
- `POST /api/speech/transcribe` accepts multipart form data with an `audio` file and returns `{ transcript, provider }`.

`POST /api/chat` accepts `{ "message": "..." }` (1–2000 characters) and returns `{ answer, citations, abstained, provider? }`. The chat UI requests `text/event-stream` and receives progress events followed by incremental answer tokens and a final response with citations; callers without that `Accept` header receive the normal JSON response. On a cache miss, the route embeds the question, calls the `hybrid_search` database function, abstains if no results meet the configured relevance threshold, then streams output from the primary Cloudflare Workers AI model. It uses the fallback Cloudflare model for transient failures before any answer text has been emitted. Each generation pass allows up to 1,600 output tokens; if the model reports that it stopped at the token limit, the app requests up to two grounded continuations and joins them into one answer. The chat route allows up to 60 seconds so continuations have time to complete. The response prompt asks for a direct, polished answer with useful Markdown structure, source citations beside factual claims, and exact financial units and periods; summaries and requested drafts receive task-specific formatting guidance. Successful answers are cached for 24 hours by default; `CHAT_CACHE_TTL_SECONDS` changes the TTL. Cache keys include a normalized question, a revision derived from indexed document checksums and names, and the retrieval/model configuration. Consequently, document re-indexing that changes corpus content or a model/prompt configuration change naturally causes a cache miss. Cache read/write failures are logged and do not prevent a fresh answer. Cloudflare Workers AI has a daily free allocation; usage above the allowance may require a paid Workers plan. Check the current [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) for details.

Before cache lookup or retrieval, `/api/chat` applies a lightweight topic policy for the Silverline corpus. Greetings receive a short redirect, and queries without board, resolution, audit, financial, or document context receive a redirect that explains what the assistant can answer. In-scope questions continue through normal retrieval, citation, and caching behavior.

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

Financial workbook ingestion normalizes quarter and half-year headers to fiscal periods and inherits declared sheet units such as `₹ crore` (while keeping EPS per-share units distinct). After updating the ingestion code or changing source files, rerun the indexing command without `--dry-run` to replace the stored facts and their search embeddings; a dry run only parses locally and does not update Supabase.

## Deploy to Vercel

The repository deploys as a single Next.js app. `vercel.json` selects the Next.js framework; Vercel’s default npm install and `next build` are used. The Python Docling CLI is **not** deployed as a Vercel service: run it locally when indexing documents.

### Before the first deployment

1. Create a Supabase project and a Cloudflare API token with Workers AI permission.
2. In Supabase SQL Editor, apply every migration in `supabase/migrations/` in filename order, including `202610250003_document_scoped_search.sql` for per-document summaries.
3. Index the sample corpus from your local machine. Follow [Index the sample corpus](#index-the-sample-corpus-explicit-local-action) below and run the command without `--dry-run`. Verify the documents appear after deployment through `/api/documents`.
4. Push this repository to GitHub and import it in Vercel. Set the Vercel project **Root Directory** to the repository root (not `ingestion`). Leave the framework, install command, build command, and output directory on their detected/default settings.
5. Set the Node.js version to 20.9 or newer, matching `package.json`.
6. In Vercel Project Settings → Environment Variables, add these **server-side** values for Production and any Preview/Development environments you intend to use:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_API_TOKEN`
7. Optionally set model/cache overrides, including speech model IDs, from `.env.example`. Never add a `NEXT_PUBLIC_` prefix to secrets.
8. Deploy. Redeploy after changing Vercel environment variables.
9. Smoke-test the deployment: open `/`, then `/api/documents` and confirm the indexed files are listed. Ask a question whose answer exists in the sample corpus and confirm the response includes citations.

The chat, document, and transcription API routes explicitly use the Node.js runtime. AI routes have a 30-second maximum duration. Vercel cannot apply database migrations or ingest local files as part of the Next.js build. The service-role key and Cloudflare token must stay server-side. A Vercel deployment does not automatically create Supabase/Cloudflare accounts, configure secrets, or populate the index.

## Checks

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
python -m unittest discover -s ingestion/tests
```

The automated tests cover citation formatting, model fallback policy, and ingestion text/table transformations. Provider, database, and full UI end-to-end checks require valid external service credentials and an indexed corpus.
