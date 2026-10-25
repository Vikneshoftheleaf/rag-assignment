-- Silverline's source documents are fictional training samples.
-- Embedding dimension must match CF_EMBEDDING_DIMENSIONS and the selected model.
create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  source_path text not null unique,
  filename text not null,
  document_type text not null check (document_type in ('pdf', 'docx', 'xlsx')),
  checksum text not null,
  metadata jsonb not null default '{}'::jsonb,
  indexed_at timestamptz not null default now()
);

create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  source_location jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  embedding extensions.vector(768) not null,
  search_vector tsvector generated always as (to_tsvector('english', content)) stored,
  unique(document_id, chunk_index)
);

create table if not exists public.structured_facts (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  fact_index integer not null,
  metric text not null,
  scope text,
  period text,
  unit text,
  value_text text not null,
  numeric_value numeric,
  source_location jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  embedding extensions.vector(768) not null,
  search_vector tsvector generated always as (
    to_tsvector('english', coalesce(metric, '') || ' ' || coalesce(scope, '') || ' ' ||
      coalesce(period, '') || ' ' || coalesce(unit, '') || ' ' || value_text)
  ) stored,
  unique(document_id, fact_index)
);

create index if not exists document_chunks_embedding_hnsw
  on public.document_chunks using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists document_chunks_search_gin
  on public.document_chunks using gin (search_vector);
create index if not exists structured_facts_embedding_hnsw
  on public.structured_facts using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists structured_facts_search_gin
  on public.structured_facts using gin (search_vector);
create index if not exists structured_facts_metric_idx
  on public.structured_facts (metric, period, scope);

alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.structured_facts enable row level security;
-- No public policies: only the server-side service-role key can access corpus data.

create or replace function public.replace_document_index(
  p_source_path text,
  p_filename text,
  p_document_type text,
  p_checksum text,
  p_metadata jsonb,
  p_chunks jsonb,
  p_facts jsonb
) returns uuid
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_document_id uuid;
  v_item jsonb;
begin
  insert into public.documents(source_path, filename, document_type, checksum, metadata, indexed_at)
  values (p_source_path, p_filename, p_document_type, p_checksum, coalesce(p_metadata, '{}'::jsonb), now())
  on conflict (source_path) do update set
    filename = excluded.filename,
    document_type = excluded.document_type,
    checksum = excluded.checksum,
    metadata = excluded.metadata,
    indexed_at = now()
  returning id into v_document_id;

  delete from public.document_chunks where document_id = v_document_id;
  delete from public.structured_facts where document_id = v_document_id;

  for v_item in select value from jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb))
  loop
    insert into public.document_chunks(document_id, chunk_index, content, source_location, metadata, embedding)
    values (
      v_document_id,
      (v_item->>'chunk_index')::integer,
      v_item->>'content',
      coalesce(v_item->'source_location', '{}'::jsonb),
      coalesce(v_item->'metadata', '{}'::jsonb),
      (v_item->'embedding')::text::extensions.vector
    );
  end loop;

  for v_item in select value from jsonb_array_elements(coalesce(p_facts, '[]'::jsonb))
  loop
    insert into public.structured_facts(
      document_id, fact_index, metric, scope, period, unit, value_text, numeric_value,
      source_location, metadata, embedding
    ) values (
      v_document_id,
      (v_item->>'fact_index')::integer,
      v_item->>'metric',
      nullif(v_item->>'scope', ''),
      nullif(v_item->>'period', ''),
      nullif(v_item->>'unit', ''),
      v_item->>'value_text',
      nullif(v_item->>'numeric_value', '')::numeric,
      coalesce(v_item->'source_location', '{}'::jsonb),
      coalesce(v_item->'metadata', '{}'::jsonb),
      (v_item->'embedding')::text::extensions.vector
    );
  end loop;
  return v_document_id;
end;
$$;

create or replace function public.hybrid_search(
  query_embedding extensions.vector(768),
  query_text text,
  match_count integer default 8
) returns table (
  result_id uuid,
  result_kind text,
  content text,
  source_filename text,
  source_type text,
  source_location jsonb,
  metadata jsonb,
  score real
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with candidates as (
    select c.id as result_id, 'chunk'::text as result_kind, c.content,
      d.filename as source_filename, d.document_type as source_type, c.source_location,
      c.metadata || jsonb_build_object('document_id', d.id) as metadata,
      greatest(
        (1 - (c.embedding <=> query_embedding))::real,
        least(ts_rank_cd(c.search_vector, websearch_to_tsquery('english', query_text)), 1.0)::real
      ) as score
    from public.document_chunks c
    join public.documents d on d.id = c.document_id
    where c.search_vector @@ websearch_to_tsquery('english', query_text)
       or c.embedding <=> query_embedding < 0.78
    union all
    select f.id, 'fact'::text,
      f.metric || ': ' || f.value_text ||
        case when f.unit is not null then ' ' || f.unit else '' end ||
        case when f.period is not null then ' (' || f.period || ')' else '' end ||
        case when f.scope is not null then ' [' || f.scope || ']' else '' end,
      d.filename, d.document_type, f.source_location,
      f.metadata || jsonb_build_object(
        'document_id', d.id, 'metric', f.metric, 'scope', f.scope,
        'period', f.period, 'unit', f.unit, 'value_text', f.value_text,
        'numeric_value', f.numeric_value
      ),
      greatest(
        (1 - (f.embedding <=> query_embedding))::real,
        least(ts_rank_cd(f.search_vector, websearch_to_tsquery('english', query_text)), 1.0)::real
      )
    from public.structured_facts f
    join public.documents d on d.id = f.document_id
    where f.search_vector @@ websearch_to_tsquery('english', query_text)
       or f.embedding <=> query_embedding < 0.78
  )
  select * from candidates
  order by score desc
  limit greatest(1, least(match_count, 20));
$$;

-- Explicitly limit execution to backend service role. RLS remains enabled on base tables.
revoke all on function public.replace_document_index(text, text, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.hybrid_search(extensions.vector, text, integer) from public, anon, authenticated;
grant execute on function public.replace_document_index(text, text, text, text, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.hybrid_search(extensions.vector, text, integer) to service_role;
