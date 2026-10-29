create or replace function public.normalize_workbook_search_text(p_text text)
returns text
language sql
immutable
parallel safe
as $$
  select btrim(regexp_replace(
    lower(coalesce(p_text, '')),
    '[^[:alnum:]]+',
    ' ',
    'g'
  ));
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
    select public.normalize_workbook_search_text(term) as term
    from unnest(coalesce(p_row_terms, '{}')) as input(term)
    where public.normalize_workbook_search_text(term) <> ''
  ),
  column_terms as (
    select public.normalize_workbook_search_text(term) as term
    from unnest(coalesce(p_column_terms, '{}')) as input(term)
    where public.normalize_workbook_search_text(term) <> ''
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
          where position(term.term in public.normalize_workbook_search_text(cell.row_label)) > 0
        )
      )
      and (
        not exists (select 1 from column_terms)
        or exists (
          select 1 from column_terms term
          where position(term.term in public.normalize_workbook_search_text(cell.column_header)) > 0
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

revoke all on function public.normalize_workbook_search_text(text)
  from public, anon, authenticated;
grant execute on function public.normalize_workbook_search_text(text)
  to service_role;
revoke all on function public.lookup_workbook_cells(
  text[], text[], text, text, text, integer, integer, uuid, integer
) from public, anon, authenticated;
grant execute on function public.lookup_workbook_cells(
  text[], text[], text, text, text, integer, integer, uuid, integer
) to service_role;
