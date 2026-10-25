create table if not exists public.chat_response_cache (
  question_key text primary key check (question_key ~ '^[0-9a-f]{64}$'),
  corpus_revision text not null check (corpus_revision ~ '^[0-9a-f]{64}$'),
  configuration_hash text not null check (configuration_hash ~ '^[0-9a-f]{64}$'),
  response jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_response_cache_expires_at_idx
  on public.chat_response_cache (expires_at);

alter table public.chat_response_cache enable row level security;

revoke all on table public.chat_response_cache from public, anon, authenticated;
grant select, insert, update, delete on table public.chat_response_cache to service_role;
