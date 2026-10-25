-- Search passages within one selected document when generating document summaries.
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
    where d.id = target_document_id
      and (
        c.search_vector @@ websearch_to_tsquery('english', query_text)
        or c.embedding <=> query_embedding < 0.78
      )
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
    where d.id = target_document_id
      and (
        f.search_vector @@ websearch_to_tsquery('english', query_text)
        or f.embedding <=> query_embedding < 0.78
      )
  )
  select * from candidates
  order by score desc
  limit greatest(1, least(match_count, 20));
$$;

revoke all on function public.document_hybrid_search(extensions.vector, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.document_hybrid_search(extensions.vector, text, uuid, integer)
  to service_role;
