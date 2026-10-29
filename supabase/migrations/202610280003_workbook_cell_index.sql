create table if not exists public.workbook_cells (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  cell_index integer not null,
  sheet_name text not null,
  row_number integer not null,
  column_number integer not null,
  cell_address text not null,
  row_label text not null default '',
  column_header text not null default '',
  value_text text not null,
  numeric_value numeric,
  cell_type text not null check (cell_type in ('text', 'numeric', 'formula')),
  period text,
  scope text,
  unit text,
  metadata jsonb not null default '{}'::jsonb,
  search_vector tsvector generated always as (
    to_tsvector(
      'simple'::regconfig,
      coalesce(sheet_name, '') || ' ' ||
      coalesce(row_label, '') || ' ' ||
      coalesce(column_header, '') || ' ' ||
      coalesce(period, '') || ' ' ||
      coalesce(scope, '') || ' ' ||
      coalesce(unit, '') || ' ' ||
      coalesce(value_text, '')
    )
  ) stored,
  unique(document_id, cell_index),
  unique(document_id, sheet_name, cell_address)
);

create index if not exists workbook_cells_document_coordinates_idx
  on public.workbook_cells(document_id, sheet_name, row_number, column_number);
create index if not exists workbook_cells_row_label_idx
  on public.workbook_cells(document_id, sheet_name, row_label);
create index if not exists workbook_cells_period_scope_idx
  on public.workbook_cells(document_id, period, scope);
create index if not exists workbook_cells_search_gin
  on public.workbook_cells using gin(search_vector);

alter table public.workbook_cells enable row level security;

create or replace function public.replace_document_index_v2(
  p_source_path text,
  p_filename text,
  p_document_type text,
  p_checksum text,
  p_metadata jsonb,
  p_chunks jsonb,
  p_facts jsonb,
  p_cells jsonb
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
  delete from public.workbook_cells where document_id = v_document_id;

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

  insert into public.workbook_cells(
    document_id, cell_index, sheet_name, row_number, column_number, cell_address,
    row_label, column_header, value_text, numeric_value, cell_type, period, scope,
    unit, metadata
  )
  select
    v_document_id,
    (item->>'cell_index')::integer,
    item->>'sheet_name',
    (item->>'row_number')::integer,
    (item->>'column_number')::integer,
    item->>'cell_address',
    coalesce(item->>'row_label', ''),
    coalesce(item->>'column_header', ''),
    item->>'value_text',
    nullif(item->>'numeric_value', '')::numeric,
    item->>'cell_type',
    nullif(item->>'period', ''),
    nullif(item->>'scope', ''),
    nullif(item->>'unit', ''),
    coalesce(item->'metadata', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_cells, '[]'::jsonb)) as cell(item);

  return v_document_id;
end;
$$;

create or replace function public.lookup_workbook_cells(
  p_row_terms text[] default '{}',
  p_column_terms text[] default '{}',
  p_period text default null,
  p_scope text default null,
  p_sheet_name text default null,
  p_row_number integer default null,
  p_column_number integer default null,
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
  with row_terms as (
    select term from unnest(coalesce(p_row_terms, '{}')) as input(term)
    where trim(term) <> ''
  ),
  column_terms as (
    select term from unnest(coalesce(p_column_terms, '{}')) as input(term)
    where trim(term) <> ''
  ),
  matches as (
    select cell.*
    from public.workbook_cells cell
    where (p_target_document_id is null or cell.document_id = p_target_document_id)
      and (p_sheet_name is null or lower(cell.sheet_name) = lower(p_sheet_name))
      and (p_row_number is null or cell.row_number = p_row_number)
      and (p_column_number is null or cell.column_number = p_column_number)
      and (
        not exists (select 1 from row_terms)
        or exists (
          select 1 from row_terms term
          where to_tsvector('simple', cell.row_label) @@
            websearch_to_tsquery('simple', term.term)
        )
      )
      and (
        not exists (select 1 from column_terms)
        or exists (
          select 1 from column_terms term
          where to_tsvector('simple', cell.column_header) @@
            websearch_to_tsquery('simple', term.term)
        )
      )
      and (
        p_period is null
        or lower(regexp_replace(coalesce(cell.period, ''), '[–/]', '-', 'g')) =
          lower(regexp_replace(p_period, '[–/]', '-', 'g'))
        or lower(regexp_replace(coalesce(cell.column_header, ''), '[–/]', '-', 'g')) like
          '%' || lower(regexp_replace(p_period, '[–/]', '-', 'g')) || '%'
      )
      and (p_scope is null or lower(coalesce(cell.scope, '')) = lower(p_scope))
    order by cell.document_id, cell.sheet_name, cell.row_number, cell.column_number
    limit greatest(1, least(p_match_count, 1000))
  )
  select
    cell.id,
    'fact'::text,
    cell.row_label || ' | ' || cell.column_header || ': ' || cell.value_text,
    document.filename,
    document.document_type,
    jsonb_build_object(
      'sheet', cell.sheet_name,
      'row', cell.row_number,
      'column', cell.column_number,
      'cell', cell.cell_address
    ),
    cell.metadata || jsonb_build_object(
      'document_id', document.id,
      'sheet_name', cell.sheet_name,
      'row_number', cell.row_number,
      'column_number', cell.column_number,
      'cell_address', cell.cell_address,
      'row_label', cell.row_label,
      'column_header', cell.column_header,
      'value_text', cell.value_text,
      'numeric_value', cell.numeric_value,
      'cell_type', cell.cell_type,
      'period', cell.period,
      'scope', cell.scope,
      'unit', cell.unit
    ),
    1.0::real
  from matches cell
  join public.documents document on document.id = cell.document_id
  order by cell.document_id, cell.sheet_name, cell.row_number, cell.column_number;
$$;

revoke all on function public.replace_document_index_v2(
  text, text, text, text, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.replace_document_index_v2(
  text, text, text, text, jsonb, jsonb, jsonb, jsonb
) to service_role;
revoke all on function public.lookup_workbook_cells(
  text[], text[], text, text, text, integer, integer, uuid, integer
) from public, anon, authenticated;
grant execute on function public.lookup_workbook_cells(
  text[], text[], text, text, text, integer, integer, uuid, integer
) to service_role;
