create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New chat' check (char_length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.chat_turns (
  id uuid primary key,
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  question text not null check (char_length(question) between 1 and 2000),
  answer text not null default '',
  citations jsonb not null default '[]'::jsonb,
  abstained boolean not null default false,
  document_id uuid references public.documents(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists chat_sessions_owner_updated_idx
  on public.chat_sessions (user_id, updated_at desc);
create index if not exists chat_turns_session_created_idx
  on public.chat_turns (session_id, created_at);

alter table public.chat_sessions enable row level security;
alter table public.chat_turns enable row level security;

create policy "Users can manage their own chat sessions"
  on public.chat_sessions for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can manage their own chat turns"
  on public.chat_turns for all to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.chat_sessions
      where chat_sessions.id = chat_turns.session_id
        and chat_sessions.user_id = auth.uid()
    )
  );

revoke all on table public.chat_sessions, public.chat_turns from public, anon;
grant select, insert, update, delete on table public.chat_sessions, public.chat_turns to authenticated, service_role;
