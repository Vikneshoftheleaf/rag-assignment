create table if not exists public.turn_feedback (
  id uuid primary key default gen_random_uuid(),
  turn_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid,
  query_text text not null,
  answer_text text not null,
  sources jsonb not null default '[]'::jsonb,
  source_ids uuid[] not null default '{}',
  query_embedding extensions.vector(768) not null,
  source_embeddings jsonb not null default '[]'::jsonb,
  corpus_revision text not null check (corpus_revision ~ '^[0-9a-f]{64}$'),
  retrieval_match_percent smallint check (
    retrieval_match_percent is null or retrieval_match_percent between 0 and 100
  ),
  vote smallint check (vote is null or vote in (-1, 1)),
  created_at timestamptz not null default now(),
  rated_at timestamptz,
  unique (user_id, turn_id)
);

create index if not exists turn_feedback_embedding_hnsw
  on public.turn_feedback using hnsw (query_embedding extensions.vector_cosine_ops)
  where vote is not null;
create index if not exists turn_feedback_user_corpus_vote_idx
  on public.turn_feedback (user_id, corpus_revision, vote, document_id);

alter table public.turn_feedback enable row level security;
revoke all on table public.turn_feedback from public, anon, authenticated;
grant select, insert, update, delete on table public.turn_feedback to service_role;

create or replace function public.match_turn_feedback_sources(
  p_query_embedding extensions.vector(768),
  p_user_id uuid,
  p_corpus_revision text,
  p_document_id uuid default null,
  p_min_similarity real default 0.78
) returns table (
  positive_source_ids uuid[],
  negative_source_ids uuid[],
  positive_match_count integer,
  negative_match_count integer
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with matching_feedback as (
    select feedback.vote,
      feedback.source_ids,
      greatest(0.0, 1.0 - (feedback.query_embedding <=> p_query_embedding))::real as similarity
    from public.turn_feedback as feedback
    where feedback.user_id = p_user_id
      and feedback.corpus_revision = p_corpus_revision
      and feedback.vote is not null
      and feedback.document_id is not distinct from p_document_id
      and 1.0 - (feedback.query_embedding <=> p_query_embedding) >=
        greatest(0.0, least(1.0, p_min_similarity))
    order by feedback.query_embedding <=> p_query_embedding
    limit 20
  ),
  source_votes as (
    select source_id,
      max(similarity) filter (where vote = 1) as positive_similarity,
      max(similarity) filter (where vote = -1) as negative_similarity
    from matching_feedback
    cross join lateral unnest(source_ids) as source_id(source_id)
    group by source_id
  )
  select
    coalesce(array_agg(source_id order by positive_similarity desc)
      filter (where positive_similarity is not null
        and positive_similarity > coalesce(negative_similarity, -1.0)), '{}'),
    coalesce(array_agg(source_id order by negative_similarity desc)
      filter (where negative_similarity is not null
        and negative_similarity >= coalesce(positive_similarity, -1.0)), '{}'),
    (select count(*)::integer from matching_feedback where vote = 1),
    (select count(*)::integer from matching_feedback where vote = -1)
  from source_votes;
$$;

create or replace function public.record_turn_feedback(
  p_turn_id uuid,
  p_user_id uuid,
  p_document_id uuid,
  p_query_text text,
  p_answer_text text,
  p_sources jsonb,
  p_query_embedding extensions.vector(768),
  p_corpus_revision text,
  p_retrieval_match_percent smallint
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  feedback_id uuid;
  source_ids uuid[];
  source_embeddings jsonb;
begin
  select coalesce(array_agg(distinct requested.source_id), '{}')
  into source_ids
  from jsonb_array_elements(coalesce(p_sources, '[]'::jsonb)) as source(source_json)
  cross join lateral (
    select (source_json->>'sourceId')::uuid as source_id
    where source_json->>'sourceId' ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) as requested;

  with requested_sources as (
    select distinct (source_json->>'sourceId')::uuid as source_id,
      source_json->>'kind' as source_kind
    from jsonb_array_elements(coalesce(p_sources, '[]'::jsonb)) as source(source_json)
    where source_json->>'sourceId' ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  found_embeddings as (
    select requested.source_id, requested.source_kind, chunk.embedding::text as embedding_text
    from requested_sources as requested
    join public.document_chunks as chunk on chunk.id = requested.source_id
    where requested.source_kind = 'chunk'
    union all
    select requested.source_id, requested.source_kind, fact.embedding::text
    from requested_sources as requested
    join public.structured_facts as fact on fact.id = requested.source_id
    where requested.source_kind = 'fact'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'sourceId', source_id,
    'kind', source_kind,
    'embedding', to_jsonb(string_to_array(trim(both '[]' from embedding_text), ',')::real[])
  )), '[]'::jsonb)
  into source_embeddings
  from found_embeddings;

  insert into public.turn_feedback (
    turn_id, user_id, document_id, query_text, answer_text, sources, source_ids,
    query_embedding, source_embeddings, corpus_revision, retrieval_match_percent,
    vote, rated_at
  ) values (
    p_turn_id, p_user_id, p_document_id, p_query_text, p_answer_text,
    coalesce(p_sources, '[]'::jsonb), source_ids, p_query_embedding,
    source_embeddings, p_corpus_revision, p_retrieval_match_percent, null, null
  )
  on conflict (user_id, turn_id) do update set
    document_id = excluded.document_id,
    query_text = excluded.query_text,
    answer_text = excluded.answer_text,
    sources = excluded.sources,
    source_ids = excluded.source_ids,
    query_embedding = excluded.query_embedding,
    source_embeddings = excluded.source_embeddings,
    corpus_revision = excluded.corpus_revision,
    retrieval_match_percent = excluded.retrieval_match_percent,
    vote = null,
    rated_at = null,
    created_at = now()
  returning id into feedback_id;

  return feedback_id;
end;
$$;

create or replace function public.get_turn_feedback_stats(
  p_user_id uuid
) returns table (
  positive_count bigint,
  negative_count bigint,
  approval_percent numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*) filter (where vote = 1),
    count(*) filter (where vote = -1),
    case when count(*) filter (where vote is not null) = 0 then null
      else round(
        100.0 * count(*) filter (where vote = 1) /
        count(*) filter (where vote is not null),
        1
      )
    end
  from public.turn_feedback
  where user_id = p_user_id;
$$;

revoke all on function public.match_turn_feedback_sources(
  extensions.vector, uuid, text, uuid, real
) from public, anon, authenticated;
revoke all on function public.record_turn_feedback(
  uuid, uuid, uuid, text, text, jsonb, extensions.vector, text, smallint
) from public, anon, authenticated;
revoke all on function public.get_turn_feedback_stats(uuid)
  from public, anon, authenticated;

grant execute on function public.match_turn_feedback_sources(
  extensions.vector, uuid, text, uuid, real
) to service_role;
grant execute on function public.record_turn_feedback(
  uuid, uuid, uuid, text, text, jsonb, extensions.vector, text, smallint
) to service_role;
grant execute on function public.get_turn_feedback_stats(uuid)
  to service_role;