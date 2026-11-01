-- Keep native Pulse recordings and imported coach reports in the SAME table.
-- Explicit app upserts do not touch history_json, so a later Pulse resend cannot
-- erase imported exercises, original flags, provenance or coach-only details.
alter table public.workouts add column if not exists history_json jsonb;
comment on column public.workouts.history_json is
  'Lossless original coach-ledger record, including source key, original completion flag, exercises/sets, metrics and provenance. Unknown measurements remain null.';
