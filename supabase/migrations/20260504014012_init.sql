-- sharetext-e2e: Supabase schema, RLS, and TTL cleanup
-- Run this once in the Supabase SQL editor.

-- 1) extensions
create extension if not exists pg_cron;

-- 2) table
create table if not exists public.snippets (
  id          text        primary key,
  ciphertext  text        not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

-- block oversize ciphertext (~64KB base64 ≈ 48KB plaintext)
alter table public.snippets
  drop constraint if exists snippets_ciphertext_size;
alter table public.snippets
  add constraint snippets_ciphertext_size check (length(ciphertext) <= 65536);

-- expires_at must be in the future and within 7 days
alter table public.snippets
  drop constraint if exists snippets_expires_window;
alter table public.snippets
  add constraint snippets_expires_window
  check (expires_at > now() and expires_at <= now() + interval '7 days 1 hour');

-- 3) RLS: anon can INSERT and SELECT only; never UPDATE/DELETE
alter table public.snippets enable row level security;

drop policy if exists snippets_insert on public.snippets;
create policy snippets_insert on public.snippets
  for insert to anon
  with check (true);

drop policy if exists snippets_select on public.snippets;
create policy snippets_select on public.snippets
  for select to anon
  using (expires_at > now());

-- (no update/delete policies → denied by default)

-- 4) TTL cleanup every minute
select cron.unschedule(jobid) from cron.job where jobname = 'snippets_ttl';
select cron.schedule(
  'snippets_ttl',
  '* * * * *',
  $$ delete from public.snippets where expires_at <= now() $$
);
