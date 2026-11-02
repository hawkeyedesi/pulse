-- Pulse — Supabase schema (v3: mirrors the coach's OpenClaw health.sqlite3; v3 adds Fuel columns)
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- It is safe to re-run (create ... if not exists / drop policy if exists).
--
-- Tables match the coach DB so the coach and Pulse share one shape:
--   days(date, notes)                                   coach: days(date TEXT PK, notes)
--   workouts(date -> days, number, kind, status, summary, polar_json, + extras)
--   meals(date, time, items, source)
--   weigh_ins(date, lbs, note)
-- Differences from SQLite: every table has a uuid primary key and a user_id
-- (default auth.uid()); Row Level Security means only the signed-in owner can read or
-- write their rows, so the anon key in the app is safe to expose. days is unique on
-- (user_id, date) instead of date alone.
--
-- Write rules (same as the coach's): upsert days first; real workout -> status 'done';
-- skip -> status 'skip', number null; demo sessions are never inserted; the same log_id
-- updates its row, never a duplicate (log_id is UNIQUE). polar_json holds the full Pulse
-- JSON. Raw RR intervals are never stored: hrv_json is a whole-session summary and
-- hr_trace_json is a 5-second averaged HR trace.
--
-- Pulse itself writes days (user_id, date only) and workouts (source 'pulse'). It never
-- sends `number`, so the session number the coach assigns survives Pulse updates.
-- v3 (Fuel): Pulse also writes meals (upsert on log_id) and weigh_ins (upsert on log_id). The
-- coach's original meal columns (date, time, items, source) are kept and filled, so its existing
-- rows and writer keep working; the new columns are additive and nullable. See the v3 section at
-- the bottom (idempotent ALTER TABLE ... ADD COLUMN IF NOT EXISTS + unique indexes).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- updated_at trigger
create or replace function public.pulse_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------- days
create table if not exists public.days (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  date        date not null,                       -- local calendar day (YYYY-MM-DD)
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, date)
);

-- ---------------------------------------------------------------- workouts
create table if not exists public.workouts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  date           date not null,
  number         integer,                          -- session number, assigned by the coach; null on skips
  kind           text check (kind in ('upper-a', 'upper-b', 'lower', 'cardio', 'other')),
  status         text not null default 'done' check (status in ('done', 'skip')),
  summary        text,                             -- one line
  polar_json     jsonb,                            -- full Pulse workout JSON (no raw RR)
  -- coach's suggested extras
  log_id         text unique,                      -- Pulse session uuid; upsert key
  revision       integer not null default 1,
  source         text check (source in ('polar', 'pulse', 'manual', 'demo')),
  started_at     timestamptz,
  ended_at       timestamptz,
  duration_s     integer,                          -- active (non-paused) seconds
  avg_hr         integer,
  max_hr         integer,
  min_hr         integer,
  calories_kcal  real,
  zones_json     jsonb,                            -- {total_s, zones:[{zone,name,min_bpm,max_bpm,seconds,pct}]}
  hrv_json       jsonb,                            -- {rr_count, rmssd_ms, sdnn_ms, pnn50_pct, ...} summary only
  hr_trace_json  jsonb,                            -- {interval_s:5, columns:[t_s,hr], points:[[t,hr],...]}
  notes_raw      text,
  -- Pulse sync bookkeeping (not in the coach DB; safe for it to ignore)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,                      -- soft delete so other devices learn about it
  foreign key (user_id, date) references public.days (user_id, date) on update cascade,
  check (status = 'done' or number is null)
);
create index if not exists workouts_user_date_idx on public.workouts (user_id, date desc);
create index if not exists workouts_user_updated_idx on public.workouts (user_id, updated_at);

-- ---------------------------------------------------------------- meals
create table if not exists public.meals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  date        date not null,
  time        text,
  items       text not null,
  source      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists meals_user_date_idx on public.meals (user_id, date desc);

-- ---------------------------------------------------------------- weigh_ins
create table if not exists public.weigh_ins (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  date        date not null,
  lbs         real not null,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists weigh_ins_user_date_idx on public.weigh_ins (user_id, date desc);

-- ---------------------------------------------------------------- triggers + RLS
do $$
declare t text;
begin
  foreach t in array array['days', 'workouts', 'meals', 'weigh_ins'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.pulse_touch_updated_at()', t || '_touch', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)', t || '_select_own', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', t || '_insert_own', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t || '_update_own', t);
    execute format('create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)', t || '_delete_own', t);
  end loop;
end $$;

-- Table privileges for the API roles (RLS still applies on top).
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.days, public.workouts, public.meals, public.weigh_ins to authenticated;
revoke all on public.days, public.workouts, public.meals, public.weigh_ins from anon;

-- ---------------------------------------------------------------- v3: Fuel (meals + weigh-ins from Pulse)
-- Safe to run on a v2 database (and to re-run). Photos are never stored here.
alter table public.meals add column if not exists log_id          text;     -- Pulse meal uuid; upsert key
alter table public.meals add column if not exists revision        integer not null default 1;
alter table public.meals add column if not exists meal            text;     -- breakfast | lunch | dinner | snack
alter table public.meals add column if not exists notes_raw       text;     -- typed / dictated note
alter table public.meals add column if not exists kcal            real;
alter table public.meals add column if not exists protein_g       real;
alter table public.meals add column if not exists carbs_g         real;
alter table public.meals add column if not exists fat_g           real;
alter table public.meals add column if not exists estimate_source text;     -- decider | decider+coach | coach | favorite | repeat | user-edit | none
alter table public.meals add column if not exists confidence      real;     -- 0..1 (mean answer confidence; user answers count as 1)
alter table public.meals add column if not exists status          text not null default 'logged';
alter table public.meals add column if not exists answers_json    jsonb;    -- items, fat, eaten, decided answers, model, threshold
alter table public.meals add column if not exists deleted_at      timestamptz;
create unique index if not exists meals_log_id_key on public.meals (log_id);
create index if not exists meals_user_updated_idx on public.meals (user_id, updated_at);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'meals_status_check') then
    alter table public.meals add constraint meals_status_check check (status in ('logged', 'skipped'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'meals_meal_check') then
    alter table public.meals add constraint meals_meal_check check (meal is null or meal in ('breakfast', 'lunch', 'dinner', 'snack'));
  end if;
end $$;

alter table public.weigh_ins add column if not exists log_id      text;     -- Pulse weigh-in uuid; upsert key
alter table public.weigh_ins add column if not exists revision    integer not null default 1;
alter table public.weigh_ins add column if not exists deleted_at  timestamptz;
create unique index if not exists weigh_ins_log_id_key on public.weigh_ins (log_id);

-- RLS / grants are unchanged (same per-user policies on meals and weigh_ins, set above).

-- ---------------------------------------------------------------- upgrading from v1
-- Pulse v1 used sessions / samples / notes (samples held raw RR intervals). Pulse v2 no
-- longer reads or writes them; each device re-pushes its local workouts into `workouts`
-- on the next sync. Once that has happened you can drop the old tables:
--   drop table if exists public.samples, public.notes, public.sessions;
