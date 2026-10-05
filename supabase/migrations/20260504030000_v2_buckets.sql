-- v2: bucket-based TTL (1h / 6h / 24h / 7d) with per-bucket cron jobs.
-- Drops v1 schema; safe because there is no production data yet.

-- 1) Unschedule any pre-existing cron jobs (idempotent)
do $$
declare j record;
begin
  for j in select jobname from cron.job
           where jobname in ('snippets_ttl',
                             'snippets_ttl_1h', 'snippets_ttl_6h',
                             'snippets_ttl_24h', 'snippets_ttl_7d') loop
    perform cron.unschedule(j.jobname);
  end loop;
end $$;

-- 2) Drop v1
drop table if exists public.snippets cascade;

-- 3) New schema: no expires_at, derive from created_at + bucket
create table public.snippets (
  id         text        primary key,
  ciphertext text        not null,
  bucket     smallint    not null,
  created_at timestamptz not null default now(),
  constraint snippets_ciphertext_size check (length(ciphertext) <= 65536),
  constraint snippets_bucket_valid    check (bucket in (1, 6, 24, 168))
);

create index snippets_bucket_created_idx on public.snippets (bucket, created_at);

-- 4) INSERT rate limit: max 60 new snippets per rolling minute (global)
create or replace function public.snippets_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recent int;
begin
  select count(*) into recent
    from public.snippets
   where created_at > now() - interval '1 minute';
  if recent >= 60 then
    raise exception 'rate limit: too many snippets created in the last minute'
      using errcode = '42901';
  end if;
  return new;
end
$$;

drop trigger if exists snippets_rate_limit_trg on public.snippets;
create trigger snippets_rate_limit_trg
  before insert on public.snippets
  for each row execute function public.snippets_rate_limit();

-- 5) RLS
alter table public.snippets enable row level security;

drop policy if exists snippets_insert on public.snippets;
create policy snippets_insert on public.snippets
  for insert to anon
  with check (true);

drop policy if exists snippets_select on public.snippets;
create policy snippets_select on public.snippets
  for select to anon
  using (created_at + make_interval(hours => bucket) > now());

-- (no update/delete policies → denied by default for anon)

-- 6) Per-bucket cron jobs
select cron.schedule('snippets_ttl_1h',  '* * * * *',
  $$ delete from public.snippets where bucket = 1   and created_at < now() - interval '1 hour' $$);

select cron.schedule('snippets_ttl_6h',  '*/5 * * * *',
  $$ delete from public.snippets where bucket = 6   and created_at < now() - interval '6 hours' $$);

select cron.schedule('snippets_ttl_24h', '*/30 * * * *',
  $$ delete from public.snippets where bucket = 24  and created_at < now() - interval '24 hours' $$);

select cron.schedule('snippets_ttl_7d',  '0 * * * *',
  $$ delete from public.snippets where bucket = 168 and created_at < now() - interval '7 days' $$);
