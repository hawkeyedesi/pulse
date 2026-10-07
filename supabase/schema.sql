-- Pulse — Supabase schema
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Every row belongs to the signed-in user (auth.uid()); Row Level Security makes sure
-- only that user can read or write it. The anon key in the app is safe to expose.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- sessions
create table if not exists public.sessions (
  id            uuid primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  started_at    timestamptz not null,
  ended_at      timestamptz,
  type          text,
  source        text not null default 'ble',          -- 'ble' | 'demo'
  duration_s    integer not null default 0,            -- active (non-paused) seconds
  avg_hr        smallint,
  max_hr        smallint,
  min_hr        smallint,
  calories      integer,
  zone_seconds  integer[] not null default '{0,0,0,0,0}',
  laps          jsonb not null default '[]'::jsonb,     -- [{n, t, elapsed_s}]
  pauses        jsonb not null default '[]'::jsonb,     -- [{start, end}] epoch ms
  gaps          jsonb not null default '[]'::jsonb,     -- signal dropouts [{start, end, startElapsed, endElapsed}]
  device        jsonb,                                  -- {name, id}
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz                             -- soft delete so other devices learn about it
);
create index if not exists sessions_user_started_idx on public.sessions (user_id, started_at desc);
create index if not exists sessions_user_updated_idx on public.sessions (user_id, updated_at);

-- ---------------------------------------------------------------- samples
-- One row per heart-rate notification (~1 per second).
create table if not exists public.samples (
  session_id  uuid not null references public.sessions (id) on delete cascade,
  seq         integer not null,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  t           timestamptz not null,
  elapsed_s   real not null,
  hr          smallint not null,
  rr_ms       integer[] not null default '{}',   -- RR intervals in milliseconds
  lap         smallint,
  primary key (session_id, seq)
);
create index if not exists samples_user_idx on public.samples (user_id);

-- ---------------------------------------------------------------- notes
create table if not exists public.notes (
  session_id  uuid primary key references public.sessions (id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  text        text not null default '',
  parsed      jsonb not null default '{}'::jsonb,  -- chips: type, focus, exercises, effort, sleep, flags
  updated_at  timestamptz not null default now()
);
create index if not exists notes_user_idx on public.notes (user_id);

-- ---------------------------------------------------------------- RLS
alter table public.sessions enable row level security;
alter table public.samples  enable row level security;
alter table public.notes    enable row level security;

-- sessions
drop policy if exists "sessions_select_own" on public.sessions;
drop policy if exists "sessions_insert_own" on public.sessions;
drop policy if exists "sessions_update_own" on public.sessions;
drop policy if exists "sessions_delete_own" on public.sessions;
create policy "sessions_select_own" on public.sessions for select to authenticated using ((select auth.uid()) = user_id);
create policy "sessions_insert_own" on public.sessions for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "sessions_update_own" on public.sessions for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "sessions_delete_own" on public.sessions for delete to authenticated using ((select auth.uid()) = user_id);

-- samples
drop policy if exists "samples_select_own" on public.samples;
drop policy if exists "samples_insert_own" on public.samples;
drop policy if exists "samples_update_own" on public.samples;
drop policy if exists "samples_delete_own" on public.samples;
create policy "samples_select_own" on public.samples for select to authenticated using ((select auth.uid()) = user_id);
create policy "samples_insert_own" on public.samples for insert to authenticated with check (
  (select auth.uid()) = user_id
  and exists (select 1 from public.sessions s where s.id = session_id and s.user_id = (select auth.uid()))
);
create policy "samples_update_own" on public.samples for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "samples_delete_own" on public.samples for delete to authenticated using ((select auth.uid()) = user_id);

-- notes
drop policy if exists "notes_select_own" on public.notes;
drop policy if exists "notes_insert_own" on public.notes;
drop policy if exists "notes_update_own" on public.notes;
drop policy if exists "notes_delete_own" on public.notes;
create policy "notes_select_own" on public.notes for select to authenticated using ((select auth.uid()) = user_id);
create policy "notes_insert_own" on public.notes for insert to authenticated with check (
  (select auth.uid()) = user_id
  and exists (select 1 from public.sessions s where s.id = session_id and s.user_id = (select auth.uid()))
);
create policy "notes_update_own" on public.notes for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "notes_delete_own" on public.notes for delete to authenticated using ((select auth.uid()) = user_id);

-- Table privileges for the API roles (RLS still applies on top).
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.sessions, public.samples, public.notes to authenticated;
revoke all on public.sessions, public.samples, public.notes from anon;
