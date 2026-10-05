# sharetext-e2e

Browser-side end-to-end encrypted text snippets. Single HTML file, Supabase backend.

## Files
- `index.html` — the entire app (UI + AES-GCM + Supabase REST calls, all inline).
- `supabase.sql` — DDL, RLS policies, and `pg_cron` TTL job. Run once in the Supabase SQL editor.

## Setup
1. Create a Supabase project (free tier).
2. Open SQL editor → paste `supabase.sql` → Run.
3. In `index.html`, replace:
   - `YOUR_PROJECT.supabase.co` (2 places: CSP `connect-src` and `SUPABASE_URL`)
   - `YOUR_ANON_KEY` (1 place: `SUPABASE_ANON_KEY`)
4. Host `index.html` anywhere static (Cloudflare Pages, GitHub Pages, etc.). The host must rewrite all paths to `index.html` so `/{id}#{key}` works (SPA fallback).

## Verify
- Open DevTools → Network. Only requests to `https://<project>.supabase.co/rest/v1/snippets` should appear.
- The `#...` fragment is never sent over HTTP, so the AES key never reaches Supabase.
- RLS denies UPDATE/DELETE for `anon`; SELECT auto-filters expired rows; `pg_cron` purges every minute.

## URL format
`https://<host>/<id>#<key>` — `id` is a 12-char base64url; `key` is 256-bit AES key in base64url.
