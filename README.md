# trustless.txt

trustless.txt encrypts text in your browser and stores only ciphertext in Cloudflare D1. The browser keeps the decryption key in the URL fragment. The Worker receives ciphertext and TTL when saving, then generates the ID and expiration timestamp. It never receives plaintext or the key.

## Threat model

The site host serves the JavaScript. A compromised host could replace the page with code that steals keys. Verify the published HTML against its GitHub build attestation when attestations are available, or self-host the HTML and Worker. Share the URL without the key and send the key separately.

## API

`POST /api/snippets` accepts `application/json` with `ciphertext` and `ttl_hours`. The allowed TTL values are `1`, `6`, `24`, and `168`. The Worker creates the ID and timestamps. A successful request returns `201` with `id` and `expires_at`.

`GET /api/snippets/{id}` returns `ciphertext` and `expires_at` while the snippet is live. Missing and expired snippets both return `404`. The API has no listing, update, or delete endpoint.

Requests must use JSON. Ciphertext must use base64url characters and fit within 65,536 characters. The API limits each IP to 10 create requests per 60 seconds.

Cloudflare's rate-limit counters are local to the serving location and eventually consistent.

## Local development

Run these commands from the repository root:

1. Install dependencies with `npm ci`.
2. Apply the migration to local D1 with `npm run db:local`.
3. Start the local Worker with `npm run dev`.

Create a snippet:

```sh
curl -s -H 'Content-Type: application/json' -d '{"ciphertext":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYX","ttl_hours":1}' http://localhost:8787/api/snippets
```

Use the returned ID to read it:

```sh
curl -s http://localhost:8787/api/snippets/ID
```

## Self-hosting

1. Create a D1 database with `npx wrangler d1 create trustless-txt`.
2. Copy its `database_id` into `wrangler.jsonc`, choose an unused positive rate-limit namespace ID, and replace the `text.numeri.xyz` route with a custom domain in your Cloudflare zone if needed.
3. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in your deploy environment.
4. Apply migrations with `npx wrangler d1 migrations apply DB --remote`.
5. Deploy with `npx wrangler deploy`.

The GitHub deploy workflow stays skipped until the repository variable `SITE_URL` is set. It also needs the `CLOUDFLARE_ACCOUNT_ID` variable and the `CLOUDFLARE_API_TOKEN` secret.

## Verify a deployment

The deploy workflow checks that `/` and a random snippet path serve the same bytes as `public/index.html`. It writes the HTML SHA-256 to the job summary. Artifact attestations are created only for public repositories.

Download and verify the published HTML:

```sh
curl -s "$SITE_URL/" -o index.html && gh attestation verify index.html --repo hmirin/trustless-txt
shasum -a 256 index.html
```
