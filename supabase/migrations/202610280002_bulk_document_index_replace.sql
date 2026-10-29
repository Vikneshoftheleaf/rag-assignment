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
set statement_timeout = '60s'
as $$
declare
  v_document_id uuid;
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

  insert into public.document_chunks(
    document_id, chunk_index, content, retrieval_text, source_location, metadata, embedding
  )
  select
    v_document_id,
    (item->>'chunk_index')::integer,
    item->>'content',
    coalesce(item->>'search_text', ''),
    coalesce(item->'source_location', '{}'::jsonb),
    coalesce(item->'metadata', '{}'::jsonb),
    (item->'embedding')::text::extensions.vector
  from jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb)) as chunk(item);

  insert into public.structured_facts(
    document_id, fact_index, metric, scope, period, unit, value_text, numeric_value,
    source_location, metadata, embedding
  )
  select
    v_document_id,
    (item->>'fact_index')::integer,
    item->>'metric',
    nullif(item->>'scope', ''),
    nullif(item->>'period', ''),
    nullif(item->>'unit', ''),
    item->>'value_text',
    nullif(item->>'numeric_value', '')::numeric,
    coalesce(item->'source_location', '{}'::jsonb),
    coalesce(item->'metadata', '{}'::jsonb),
    (item->'embedding')::text::extensions.vector
  from jsonb_array_elements(coalesce(p_facts, '[]'::jsonb)) as fact(item);

  return v_document_id;
end;
$$;

revoke all on function public.replace_document_index(text, text, text, text, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_document_index(text, text, text, text, jsonb, jsonb, jsonb)
  to service_role;
