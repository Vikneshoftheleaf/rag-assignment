do $$
declare
  existing_primary_key_name text;
  existing_primary_key_columns text[];
begin
  select constraint_info.conname,
    array_agg(attribute_info.attname::text order by key_column.ordinality)
  into existing_primary_key_name, existing_primary_key_columns
  from pg_constraint as constraint_info
  cross join lateral unnest(constraint_info.conkey) with ordinality
    as key_column(attnum, ordinality)
  join pg_attribute as attribute_info
    on attribute_info.attrelid = constraint_info.conrelid
    and attribute_info.attnum = key_column.attnum
  where constraint_info.conrelid = 'public.chat_response_cache'::regclass
    and constraint_info.contype = 'p'
  group by constraint_info.conname;

  if existing_primary_key_name is not null
    and existing_primary_key_columns is distinct from
      array['question_key', 'corpus_revision', 'configuration_hash']::text[]
  then
    execute format(
      'alter table public.chat_response_cache drop constraint %I',
      existing_primary_key_name
    );
  end if;
end;
$$;

with ranked_cache_entries as (
  select ctid,
    row_number() over (
      partition by question_key, corpus_revision, configuration_hash
      order by created_at desc, expires_at desc, ctid desc
    ) as duplicate_rank
  from public.chat_response_cache
)
delete from public.chat_response_cache as cache_entry
using ranked_cache_entries
where cache_entry.ctid = ranked_cache_entries.ctid
  and ranked_cache_entries.duplicate_rank > 1;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.chat_response_cache'::regclass
      and contype = 'p'
  ) then
    alter table public.chat_response_cache
      add constraint chat_response_cache_pkey
      primary key (question_key, corpus_revision, configuration_hash);
  end if;
end;
$$;
