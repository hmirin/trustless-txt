# trustless.txt

Encrypted text that deletes itself.

**<https://text.numeri.xyz/>**

Paste text, choose how long it lives (1 hour to 7 days), and get a link. The text is encrypted in your browser before anything is sent. The key stays after the `#` in the link, which browsers never send to a server.

## How it works

1. The page makes a random 18-character key and derives an AES-256-GCM key from it with PBKDF2-SHA256 (600,000 iterations).
2. It encrypts the text and uploads only the ciphertext and the chosen lifetime.
3. The server assigns the ID and expiry, stores the ciphertext in Cloudflare D1, and returns the ID.
4. The link is `https://text.numeri.xyz/<id>#<key>`. Opening it fetches the ciphertext and decrypts it in the browser, then removes the key from the address bar.
5. Expired snippets are never returned. A cron trigger deletes them every 15 minutes.

The server sees the ciphertext, its size and expiry, and the client IP and request times. It never sees the text or the key.

To share with someone else, send the link and the key on separate channels. A full link with the key is fine for moving text between your own devices; anyone who sees it can read the text.

## Verify the page you are running

A web page is only as trustworthy as the server that sends it. A compromised host could serve a page that steals keys. To make that checkable, the app is a single HTML file with no external scripts, and every deploy from this repository attests its SHA-256 with GitHub artifact attestations (Sigstore):

```sh
curl -s https://text.numeri.xyz/ -o index.html
gh attestation verify index.html --repo hmirin/trustless-txt
```

The deploy workflow also fails unless the live `/` and a random `/<id>` serve exactly the bytes of `public/index.html`. Each run lists that digest in its job summary.

If you would rather not trust any host, run your own copy.

## Self-hosting

Requires a Cloudflare account (the Workers Free plan is enough).

1. `npm ci`
2. `npx wrangler d1 create trustless-txt`, then put the returned `database_id` in `wrangler.jsonc`.
3. Replace the `text.numeri.xyz` route in `wrangler.jsonc` with your own domain.
4. `npx wrangler d1 migrations apply DB --remote`
5. `npx wrangler deploy`

To deploy from GitHub Actions like this repository does, set the `CLOUDFLARE_API_TOKEN` secret and the `CLOUDFLARE_ACCOUNT_ID` and `SITE_URL` variables. The deploy job is skipped until `SITE_URL` is set. Attestations are created only for public repositories.

## API

| Request | Response |
|---|---|
| `POST /api/snippets` with JSON `{"ciphertext": "<base64url>", "ttl_hours": 1 \| 6 \| 24 \| 168}` | `201 {"id", "expires_at"}` |
| `GET /api/snippets/{id}` | `200 {"ciphertext", "expires_at"}`, or `404` if missing or expired |

- There is no endpoint to list, update, or delete snippets.
- `POST` requires `Content-Type: application/json`, so plain cross-site forms cannot create snippets.
- Ciphertext must be base64url and at most 65,536 characters.
- Each IP can create 10 snippets per minute. The counter is kept in D1 under a SHA-256 hash of the IP and cleared by the cron trigger.
- New snippets are refused with `503` when the database nears the D1 Free plan size limit (`DB_MAX_SIZE_BYTES`, 400 MiB by default).

## Development

```sh
npm ci
npm run db:local   # apply migrations to the local D1
npm run dev        # http://localhost:8787
npm test
```

## License

[MIT](LICENSE)
