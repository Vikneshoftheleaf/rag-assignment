alter table public.document_chunks
  add column if not exists retrieval_text text not null default '';

alter table public.document_chunks
  drop column if exists search_vector;

alter table public.document_chunks
  add column search_vector tsvector generated always as (
    to_tsvector('english', content || ' ' || retrieval_text)
  ) stored;

create index if not exists document_chunks_search_gin
  on public.document_chunks using gin (search_vector);

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
    insert into public.document_chunks(
      document_id, chunk_index, content, retrieval_text, source_location, metadata, embedding
    )
    values (
      v_document_id,
      (v_item->>'chunk_index')::integer,
      v_item->>'content',
      coalesce(v_item->>'search_text', ''),
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
