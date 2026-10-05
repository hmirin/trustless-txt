-- v3: collapse 4 cron jobs into a single 5-minute cron that runs all bucket deletes.
-- 1h items may live up to ~5 min past expiry — acceptable, ciphertext is opaque.

-- 1) Unschedule v2 jobs (idempotent)
do $$
declare j record;
begin
  for j in select jobname from cron.job
           where jobname in ('snippets_ttl_1h', 'snippets_ttl_6h',
                             'snippets_ttl_24h', 'snippets_ttl_7d',
                             'snippets_cleanup') loop
    perform cron.unschedule(j.jobname);
  end loop;
end $$;

-- 2) Cleanup function (one place to edit if buckets change)
create or replace function public.cleanup_snippets()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.snippets where bucket = 1   and created_at < now() - interval '1 hour';
  delete from public.snippets where bucket = 6   and created_at < now() - interval '6 hours';
  delete from public.snippets where bucket = 24  and created_at < now() - interval '24 hours';
  delete from public.snippets where bucket = 168 and created_at < now() - interval '7 days';
$$;

-- 3) Single cron, every 5 minutes
select cron.schedule(
  'snippets_cleanup',
  '*/5 * * * *',
  $$ select public.cleanup_snippets() $$
);
