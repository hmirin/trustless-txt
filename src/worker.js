const MAX_CIPHERTEXT_CHARS = 65_536;
const MAX_BODY_BYTES = MAX_CIPHERTEXT_CHARS + 1_024;
const DEFAULT_DB_MAX_SIZE_BYTES = 400 * 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 10;
const TTL_HOURS = new Set([1, 6, 24, 168]);
const ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const CIPHERTEXT_PATTERN = /^[A-Za-z0-9_-]+$/;
const API_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {...API_HEADERS, ...headers},
  });
}

function error(code, message, status, headers) {
  return json({error: code, message}, status, headers);
}

function badRequest(message = 'The request is invalid.') {
  return error('invalid_request', message, 400);
}

function tooLarge(message = 'The request is too large.') {
  return error('payload_too_large', message, 413);
}

async function readBody(request) {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null) {
    if (!/^[0-9]+$/.test(contentLength)) return {response: badRequest('Content-Length is invalid.')};
    if (!Number.isSafeInteger(Number(contentLength)) || Number(contentLength) > MAX_BODY_BYTES) {
      return {response: tooLarge()};
    }
  }

  if (!request.body) return {bytes: new Uint8Array()};
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return {response: tooLarge()};
      }
      chunks.push(value);
    }
  } catch {
    return {response: badRequest('The request body could not be read.')};
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {bytes};
}

async function parseCreateInput(request) {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    return {response: error('unsupported_media_type', 'Content-Type must be application/json.', 415)};
  }

  const bodyResult = await readBody(request);
  if (bodyResult.response) return bodyResult;

  let body;
  try {
    body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bodyResult.bytes));
  } catch {
    return {response: badRequest('The request body must contain valid JSON.')};
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {response: badRequest('The request body must be a JSON object.')};
  }
  const keys = Object.keys(body);
  if (keys.length !== 2 || !Object.hasOwn(body, 'ciphertext') || !Object.hasOwn(body, 'ttl_hours')) {
    return {response: badRequest('Only ciphertext and ttl_hours are accepted.')};
  }
  if (typeof body.ciphertext !== 'string' || body.ciphertext.length === 0 || !CIPHERTEXT_PATTERN.test(body.ciphertext)) {
    return {response: badRequest('ciphertext must use base64url characters.')};
  }
  if (body.ciphertext.length > MAX_CIPHERTEXT_CHARS) {
    return {response: tooLarge('Ciphertext must not exceed 65,536 characters.')};
  }
  if (!Number.isInteger(body.ttl_hours) || !TTL_HOURS.has(body.ttl_hours)) {
    return {response: badRequest('ttl_hours must be 1, 6, 24, or 168.')};
  }
  return {input: {ciphertext: body.ciphertext, ttlHours: body.ttl_hours}};
}

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function isIdCollision(cause) {
  return /(?:UNIQUE|PRIMARY KEY) constraint failed: snippets\.id/i.test(String(cause?.message ?? cause));
}

function databaseSizeLimit(env) {
  if (env.DB_MAX_SIZE_BYTES === undefined) return DEFAULT_DB_MAX_SIZE_BYTES;
  const limit = Number(env.DB_MAX_SIZE_BYTES);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid DB_MAX_SIZE_BYTES');
  return limit;
}

async function createSnippet(input, env) {
  let sizeResult;
  let maxSize;
  try {
    maxSize = databaseSizeLimit(env);
    sizeResult = await env.DB.prepare('SELECT 1 AS ready').run();
  } catch {
    return error('storage_unavailable', 'Snippet storage is temporarily unavailable.', 503);
  }
  const size = sizeResult.meta?.size_after;
  if (!Number.isSafeInteger(size)) {
    return error('storage_unavailable', 'Snippet storage is temporarily unavailable.', 503);
  }
  if (size >= maxSize) {
    return error('storage_full', 'Snippet storage is full. Try again later.', 503);
  }

  const createdAt = Date.now();
  const expiresAt = createdAt + input.ttlHours * HOUR_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = newId();
    try {
      await env.DB.prepare(
        'INSERT INTO snippets (id, ciphertext, created_at, expires_at) VALUES (?, ?, ?, ?)',
      ).bind(id, input.ciphertext, createdAt, expiresAt).run();
      return json({id, expires_at: new Date(expiresAt).toISOString()}, 201);
    } catch (cause) {
      if (attempt === 0 && isIdCollision(cause)) continue;
      if (/SQLITE_FULL|database or disk is full|database size limit/i.test(String(cause?.message ?? cause))) {
        return error('storage_full', 'Snippet storage is full. Try again later.', 503);
      }
      return error('storage_unavailable', 'Snippet storage is temporarily unavailable.', 503);
    }
  }
  return error('id_generation_failed', 'A snippet ID could not be generated. Try again.', 503);
}

async function getSnippet(id, env) {
  if (!ID_PATTERN.test(id)) return badRequest('The snippet ID is invalid.');
  try {
    const row = await env.DB.prepare(
      'SELECT ciphertext, expires_at FROM snippets WHERE id = ? AND expires_at > ?',
    ).bind(id, Date.now()).first();
    if (!row) return error('not_found', 'Snippet not found or expired.', 404);
    return json({ciphertext: row.ciphertext, expires_at: new Date(row.expires_at).toISOString()});
  } catch {
    return error('storage_unavailable', 'Snippet storage is temporarily unavailable.', 503);
  }
}

async function clientKey(request) {
  // Store a hash, not the raw IP. Rows live one minute plus the cleanup interval.
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`trustless-txt/rate/${ip}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Fixed one-minute window counted in D1. Cloudflare's Rate Limiting binding is
// eventually consistent and let 33 creates in 40 s through in production.
async function createRateLimitResponse(request, env) {
  const now = Date.now();
  const windowStart = now - (now % RATE_WINDOW_MS);
  try {
    const row = await env.DB.prepare(
      'INSERT INTO rate_limits (client, window_start, count) VALUES (?, ?, 1) ' +
      'ON CONFLICT(client, window_start) DO UPDATE SET count = count + 1 RETURNING count',
    ).bind(await clientKey(request), windowStart).first();
    if (row.count <= RATE_LIMIT) return null;
    const retryAfter = Math.max(1, Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1000));
    return error('rate_limited', 'Too many snippets from this IP. Try again in a minute.', 429, {'Retry-After': String(retryAfter)});
  } catch {
    return error('rate_limit_unavailable', 'Snippet creation is temporarily unavailable.', 503);
  }
}

async function api(request, env, url) {
  if (url.pathname === '/api/snippets') {
    if (request.method !== 'POST') {
      return error('method_not_allowed', 'Use POST for this endpoint.', 405, {Allow: 'POST'});
    }
    const limited = await createRateLimitResponse(request, env);
    if (limited) return limited;
    const parsed = await parseCreateInput(request);
    if (parsed.response) return parsed.response;
    return createSnippet(parsed.input, env);
  }

  const match = /^\/api\/snippets\/([^/]+)$/.exec(url.pathname);
  if (match) {
    if (request.method !== 'GET') {
      return error('method_not_allowed', 'Use GET for this endpoint.', 405, {Allow: 'GET'});
    }
    return getSnippet(match[1], env);
  }

  return error('not_found', 'API endpoint not found.', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return api(request, env, url);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env) {
    const now = Date.now();
    await env.DB.prepare('DELETE FROM snippets WHERE expires_at <= ?').bind(now).run();
    await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - RATE_WINDOW_MS).run();
  },
};
