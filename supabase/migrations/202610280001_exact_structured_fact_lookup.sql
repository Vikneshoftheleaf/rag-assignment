create or replace function public.lookup_structured_facts(
  p_metric_terms text[],
  p_period text default null,
  p_scope text default null,
  p_target_document_id uuid default null,
  p_match_count integer default 1000
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
  with requested_terms as (
    select lower(trim(term)) as term
    from unnest(coalesce(p_metric_terms, '{}')) as terms(term)
    where trim(term) <> ''
  ),
  matching_facts as (
    select f.id,
      f.document_id,
      f.metric,
      f.scope,
      f.period,
      f.unit,
      f.value_text,
      f.numeric_value,
      f.source_location,
      f.metadata
    from public.structured_facts f
    where (p_target_document_id is null or f.document_id = p_target_document_id)
      and (
        not exists (select 1 from requested_terms)
        or exists (
          select 1
          from requested_terms term
          where f.search_vector @@ websearch_to_tsquery('english', term.term)
        )
      )
      and (
        p_scope is null
        or lower(coalesce(f.scope, '')) = lower(p_scope)
      )
      and (
        p_period is null
        or lower(regexp_replace(coalesce(f.period, ''), '[–/]', '-', 'g')) =
          lower(regexp_replace(p_period, '[–/]', '-', 'g'))
        or lower(regexp_replace(coalesce(f.period, ''), '[–/]', '-', 'g')) like
          lower(regexp_replace(p_period, '[–/]', '-', 'g')) || ' %'
        or lower(regexp_replace(coalesce(f.period, ''), '[–/]', '-', 'g')) like
          '%' || lower(regexp_replace(p_period, '[–/]', '-', 'g')) || '%'
        or lower(regexp_replace(coalesce(f.metadata->>'column_header', ''), '[–/]', '-', 'g'))
          like '%' || lower(regexp_replace(p_period, '[–/]', '-', 'g')) || '%'
      )
    order by f.document_id, f.fact_index
    limit greatest(1, least(p_match_count, 1000))
  )
  select
    f.id as result_id,
    'fact'::text as result_kind,
    f.metric || ': ' || f.value_text ||
      case when f.unit is not null then ' ' || f.unit else '' end ||
      case when f.period is not null then ' (' || f.period || ')' else '' end ||
      case when f.scope is not null then ' [' || f.scope || ']' else '' end as content,
    d.filename as source_filename,
    d.document_type as source_type,
    f.source_location,
    f.metadata || jsonb_build_object(
      'document_id', d.id,
      'metric', f.metric,
      'scope', f.scope,
      'period', f.period,
      'unit', f.unit,
      'value_text', f.value_text,
      'numeric_value', f.numeric_value
    ) as metadata,
    1.0::real as score
  from matching_facts f
  join public.documents d on d.id = f.document_id
  order by f.document_id, f.source_location->>'sheet', f.source_location->>'row',
    f.source_location->>'cell';
$$;

revoke all on function public.lookup_structured_facts(text[], text, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.lookup_structured_facts(text[], text, text, uuid, integer)
  to service_role;
