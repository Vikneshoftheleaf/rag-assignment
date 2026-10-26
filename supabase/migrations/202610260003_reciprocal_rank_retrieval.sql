create or replace function public.rank_document_evidence(
  query_embedding extensions.vector(768),
  query_text text,
  target_document_id uuid default null,
  candidate_count integer default 50,
  result_count integer default 50
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
  with search_query as (
    select websearch_to_tsquery('english', coalesce(query_text, '')) as tsquery
  ),
  chunk_vector_candidates as (
    select c.id as item_id,
      row_number() over (order by c.embedding <=> query_embedding)::integer as vector_rank,
      greatest(0.0, least(1.0, (1 - (c.embedding <=> query_embedding))::real)) as vector_similarity
    from public.document_chunks c
    where target_document_id is null or c.document_id = target_document_id
    order by c.embedding <=> query_embedding
    limit greatest(1, least(candidate_count, 100))
  ),
  chunk_text_candidates as (
    select c.id as item_id,
      row_number() over (
        order by ts_rank_cd(c.search_vector, q.tsquery) desc
      )::integer as text_rank
    from public.document_chunks c
    cross join search_query q
    where (target_document_id is null or c.document_id = target_document_id)
      and c.search_vector @@ q.tsquery
    order by ts_rank_cd(c.search_vector, q.tsquery) desc
    limit greatest(1, least(candidate_count, 100))
  ),
  fact_vector_candidates as (
    select f.id as item_id,
      row_number() over (order by f.embedding <=> query_embedding)::integer as vector_rank,
      greatest(0.0, least(1.0, (1 - (f.embedding <=> query_embedding))::real)) as vector_similarity
    from public.structured_facts f
    where target_document_id is null or f.document_id = target_document_id
    order by f.embedding <=> query_embedding
    limit greatest(1, least(candidate_count, 100))
  ),
  fact_text_candidates as (
    select f.id as item_id,
      row_number() over (
        order by ts_rank_cd(f.search_vector, q.tsquery) desc
      )::integer as text_rank
    from public.structured_facts f
    cross join search_query q
    where (target_document_id is null or f.document_id = target_document_id)
      and f.search_vector @@ q.tsquery
    order by ts_rank_cd(f.search_vector, q.tsquery) desc
    limit greatest(1, least(candidate_count, 100))
  ),
  chunk_rank_signals as (
    select item_id, vector_rank, null::integer as text_rank, vector_similarity
    from chunk_vector_candidates
    union all
    select item_id, null::integer, text_rank, 0::real
    from chunk_text_candidates
  ),
  fact_rank_signals as (
    select item_id, vector_rank, null::integer as text_rank, vector_similarity
    from fact_vector_candidates
    union all
    select item_id, null::integer, text_rank, 0::real
    from fact_text_candidates
  ),
  chunk_ranks as (
    select item_id, min(vector_rank) as vector_rank, min(text_rank) as text_rank,
      max(vector_similarity) as vector_similarity
    from chunk_rank_signals
    group by item_id
  ),
  fact_ranks as (
    select item_id, min(vector_rank) as vector_rank, min(text_rank) as text_rank,
      max(vector_similarity) as vector_similarity
    from fact_rank_signals
    group by item_id
  ),
  ranked_chunks as (
    select c.id as result_id,
      'chunk'::text as result_kind,
      c.content,
      d.filename as source_filename,
      d.document_type as source_type,
      c.source_location,
      c.metadata || jsonb_build_object('document_id', d.id) as metadata,
      least(
        1.0,
        coalesce(0.40 / sqrt(r.vector_rank::real), 0.0) +
        coalesce(0.35 / sqrt(r.text_rank::real), 0.0) +
        0.25 * coalesce(r.vector_similarity, 0.0)
      )::real as score
    from chunk_ranks r
    join public.document_chunks c on c.id = r.item_id
    join public.documents d on d.id = c.document_id
  ),
  ranked_facts as (
    select f.id as result_id,
      'fact'::text as result_kind,
      f.metric || ': ' || f.value_text ||
        case when f.unit is not null then ' ' || f.unit else '' end ||
        case when f.period is not null then ' (' || f.period || ')' else '' end ||
        case when f.scope is not null then ' [' || f.scope || ']' else '' end as content,
      d.filename as source_filename,
      d.document_type as source_type,
      f.source_location,
      f.metadata || jsonb_build_object(
        'document_id', d.id, 'metric', f.metric, 'scope', f.scope,
        'period', f.period, 'unit', f.unit, 'value_text', f.value_text,
        'numeric_value', f.numeric_value
      ) as metadata,
      least(
        1.0,
        coalesce(0.40 / sqrt(r.vector_rank::real), 0.0) +
        coalesce(0.35 / sqrt(r.text_rank::real), 0.0) +
        0.25 * coalesce(r.vector_similarity, 0.0)
      )::real as score
    from fact_ranks r
    join public.structured_facts f on f.id = r.item_id
    join public.documents d on d.id = f.document_id
  )
  select combined.*
  from (
    select * from ranked_chunks
    union all
    select * from ranked_facts
  ) combined
  order by combined.score desc
  limit greatest(1, least(result_count, 50));
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
  select *
  from public.rank_document_evidence(
    query_embedding, query_text, null, 100, greatest(1, least(match_count, 50))
  );
$$;

create or replace function public.document_hybrid_search(
  query_embedding extensions.vector(768),
  query_text text,
  target_document_id uuid,
  match_count integer default 20
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
  select *
  from public.rank_document_evidence(
    query_embedding, query_text, target_document_id, 100, greatest(1, least(match_count, 50))
  );
$$;

revoke all on function public.rank_document_evidence(extensions.vector, text, uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.hybrid_search(extensions.vector, text, integer)
  from public, anon, authenticated;
revoke all on function public.document_hybrid_search(extensions.vector, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.rank_document_evidence(extensions.vector, text, uuid, integer, integer)
  to service_role;
grant execute on function public.hybrid_search(extensions.vector, text, integer)
  to service_role;
grant execute on function public.document_hybrid_search(extensions.vector, text, uuid, integer)
  to service_role;
