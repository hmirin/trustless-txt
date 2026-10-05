import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {after, before, test} from 'node:test';
import {Miniflare} from 'miniflare';
import snippetWorker from '../src/worker.js';

const migration = (await Promise.all(['0001_snippets.sql', '0002_rate_limits.sql']
  .map((file) => readFile(`migrations/${file}`, 'utf8')))).join(';\n');
const payload = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYX';
let mf;
let workerNumber = 0;

const CONTROL_WORKER = `export default {
  async fetch(request, env) {
    const {action, sql, params = []} = await request.json();
    if (action === 'migrate') {
      for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) {
        await env.DB.prepare(statement).run();
      }
      return Response.json({success: true});
    }
    const statement = env.DB.prepare(sql);
    const bound = params.length ? statement.bind(...params) : statement;
    return Response.json(action === 'first' ? await bound.first() : await bound.run());
  },
};`;

async function makeWorker(maxSize = 419_430_400) {
  const databaseName = `trustless-txt-test-${++workerNumber}`;
  const instance = new Miniflare({workers: [
    {
      name: 'trustless-txt',
      modules: true,
      modulesRules: [{type: 'ESModule', include: ['**/*.js']}],
      findAdditionalModules: true,
      scriptPath: 'src/worker.js',
      compatibilityDate: '2026-08-06',
      d1Databases: {DB: databaseName},
      bindings: {DB_MAX_SIZE_BYTES: String(maxSize)},
      serviceBindings: {ASSETS: () => new Response('asset')},
    },
    {
      name: 'test-control',
      modules: true,
      script: CONTROL_WORKER,
      compatibilityDate: '2026-08-06',
      d1Databases: {DB: databaseName},
      routes: ['http://127.0.0.1/db/*'],
    },
  ]});
  try {
    await dbCommand({action: 'migrate', sql: migration}, instance);
  } catch (cause) {
    await instance.dispose();
    throw cause;
  }
  return instance;
}

async function dbCommand(command, instance = mf) {
  const response = await instance.dispatchFetch('http://127.0.0.1/db/query', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`test database command failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function request(path, {method = 'GET', body, ip = '198.51.100.1', contentType = 'application/json', headers: extraHeaders = {}} = {}) {
  const headers = new Headers(extraHeaders);
  headers.set('CF-Connecting-IP', ip);
  if (contentType) headers.set('Content-Type', contentType);
  return mf.dispatchFetch(`https://text.numeri.xyz${path}`, {method, headers, body});
}

function assertApiHeaders(response) {
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/json(?:;|$)/);
  assert.equal(response.headers.has('Access-Control-Allow-Origin'), false);
}

async function createSnippet({ip = '198.51.100.2', data = {ciphertext: payload, ttl_hours: 1}} = {}) {
  const response = await request('/api/snippets', {method: 'POST', body: JSON.stringify(data), ip});
  assertApiHeaders(response);
  return {response, body: await response.json()};
}

async function row(id) {
  return dbCommand({action: 'first', sql: 'SELECT * FROM snippets WHERE id = ?', params: [id]});
}

before(async () => {
  mf = await makeWorker();
});

after(async () => {
  await mf?.dispose();
});

test('create and get return a server-generated ID and only the live ciphertext fields', async () => {
  const {response, body} = await createSnippet();
  assert.equal(response.status, 201);
  assert.match(body.id, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(Buffer.from(body.id, 'base64url').length, 12);
  assert.equal(Object.keys(body).sort().join(','), 'expires_at,id');

  const stored = await row(body.id);
  assert.equal(stored.ciphertext, payload);
  assert.equal(Number.isSafeInteger(stored.created_at), true);
  assert.equal(Number.isSafeInteger(stored.expires_at), true);
  assert.ok(Math.abs(Date.now() - stored.created_at) < 2_000);
  assert.equal(stored.expires_at - stored.created_at, 60 * 60 * 1000);
  assert.equal(body.expires_at, new Date(stored.expires_at).toISOString());

  const read = await request(`/api/snippets/${body.id}`);
  assert.equal(read.status, 200);
  assertApiHeaders(read);
  assert.deepEqual(await read.json(), {ciphertext: payload, expires_at: body.expires_at});
});

test('client-supplied identity and timestamps are rejected', async () => {
  const forbiddenFields = [
    {id: 'AAAAAAAAAAAAAAAA'},
    {created_at: 1},
    {expires_at: '2099-01-01T00:00:00.000Z'},
  ];
  for (const [index, extra] of forbiddenFields.entries()) {
    const {response} = await createSnippet({
      ip: `198.51.100.${10 + index}`,
      data: {ciphertext: payload, ttl_hours: 1, ...extra},
    });
    assert.equal(response.status, 400);
  }
  assert.equal((await dbCommand({action: 'first', sql: 'SELECT COUNT(*) AS count FROM snippets'})).count, 1);
});

test('content type, JSON, ciphertext size and TTL are validated', async () => {
  const wrongType = await request('/api/snippets', {
    method: 'POST', body: 'ciphertext=abc', contentType: 'application/x-www-form-urlencoded', ip: '198.51.100.20',
  });
  assert.equal(wrongType.status, 415);
  assertApiHeaders(wrongType);

  const missingType = await request('/api/snippets', {
    method: 'POST', body: JSON.stringify({ciphertext: payload, ttl_hours: 1}), contentType: null, ip: '198.51.100.21',
  });
  assert.equal(missingType.status, 415);

  for (const [data, status] of [
    ['{', 400],
    [{ciphertext: 'ab+c', ttl_hours: 1}, 400],
    [{ciphertext: payload, ttl_hours: 2}, 400],
    [{ciphertext: 'A'.repeat(65_537), ttl_hours: 1}, 413],
  ]) {
    const response = await request('/api/snippets', {
      method: 'POST', body: typeof data === 'string' ? data : JSON.stringify(data), ip: `198.51.100.${30 + status}`,
    });
    assert.equal(response.status, status);
    assertApiHeaders(response);
  }

  const oversizedBody = await request('/api/snippets', {
    method: 'POST', body: `{"ciphertext":"${'A'.repeat(70_000)}"}`, ip: '198.51.100.40',
  });
  assert.equal(oversizedBody.status, 413);

  const atLimit = await request('/api/snippets', {
    method: 'POST',
    body: JSON.stringify({ciphertext: 'A'.repeat(65_536), ttl_hours: 1}),
    ip: '198.51.100.42',
  });
  assert.equal(atLimit.status, 201);
  assertApiHeaders(atLimit);

  const oversizedLength = await request('/api/snippets', {
    method: 'POST',
    headers: {'Content-Length': '66561'},
    body: 'x'.repeat(66_561),
    ip: '198.51.100.41',
  });
  assert.equal(oversizedLength.status, 413);
});

test('expired rows are hidden before scheduled cleanup and match missing IDs', async () => {
  const {body} = await createSnippet({ip: '198.51.100.50'});
  await dbCommand({action: 'run', sql: 'UPDATE snippets SET expires_at = ? WHERE id = ?', params: [Date.now() - 1, body.id]});

  const expired = await request(`/api/snippets/${body.id}`);
  const missing = await request('/api/snippets/BBBBBBBBBBBBBBBB');
  assert.equal(expired.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(await expired.text(), await missing.text());
  assert.ok(await row(body.id), 'expired data stays in D1 until scheduled cleanup');
});

test('scheduled cleanup deletes expired rows and preserves live rows', async () => {
  const expired = await createSnippet({ip: '198.51.100.60'});
  const live = await createSnippet({ip: '198.51.100.61'});
  await dbCommand({action: 'run', sql: 'UPDATE snippets SET expires_at = ? WHERE id = ?', params: [Date.now() - 1, expired.body.id]});
  await dbCommand({action: 'run', sql: 'UPDATE snippets SET expires_at = ? WHERE id = ?', params: [Date.now() + 3_600_000, live.body.id]});

  const database = {
    prepare(sql) {
      return {bind(...params) { return {run: () => dbCommand({action: 'run', sql, params})}; }};
    },
  };
  await snippetWorker.scheduled({scheduledTime: new Date(), cron: '*/15 * * * *'}, {DB: database});

  assert.equal(await row(expired.body.id), null);
  assert.ok(await row(live.body.id));
});

test('the API has no listing route and unsupported API methods return JSON', async () => {
  const listing = await request('/api/snippets');
  assert.equal(listing.status, 405);
  assertApiHeaders(listing);

  const unknown = await request('/api/elsewhere');
  assert.equal(unknown.status, 404);
  assertApiHeaders(unknown);

  const options = await request('/api/snippets', {method: 'OPTIONS'});
  assert.equal(options.status, 405);
  assertApiHeaders(options);

  const wrongMethod = await request('/api/snippets/CCCCCCCCCCCCCCCC', {method: 'DELETE'});
  assert.equal(wrongMethod.status, 405);
  assertApiHeaders(wrongMethod);

  const badId = await request('/api/snippets/short');
  assert.equal(badId.status, 400);
  assertApiHeaders(badId);
});

test('the D1 rate limit returns 429 after ten creates per client IP and keeps other IPs separate', async () => {
  const statuses = [];
  for (let index = 0; index < 11; index++) {
    const response = await request('/api/snippets', {
      method: 'POST',
      body: JSON.stringify({ciphertext: payload, ttl_hours: 1}),
      ip: '203.0.113.70',
    });
    statuses.push(response.status);
    assertApiHeaders(response);
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After'));
      assert.ok(retryAfter >= 1 && retryAfter <= 60);
      assert.equal((await response.json()).error, 'rate_limited');
    }
  }
  assert.deepEqual(statuses, [...Array(10).fill(201), 429]);
  const otherIp = await request('/api/snippets', {method: 'POST', body: JSON.stringify({ciphertext: payload, ttl_hours: 1}), ip: '203.0.113.71'});
  assert.equal(otherIp.status, 201);
  const stored = await dbCommand({action: 'first', sql: 'SELECT client FROM rate_limits LIMIT 1'});
  assert.match(stored.client, /^[0-9a-f]{64}$/);
});

test('the database size guard returns 503 before inserting', async () => {
  const instance = await makeWorker(1);
  try {
    const response = await instance.dispatchFetch('https://text.numeri.xyz/api/snippets', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.80'},
      body: JSON.stringify({ciphertext: payload, ttl_hours: 1}),
    });
    assert.equal(response.status, 503, await response.clone().text());
    const result = await response.json();
    assert.equal(result.error, 'storage_full');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal((await dbCommand({action: 'first', sql: 'SELECT COUNT(*) AS count FROM snippets'}, instance)).count, 0);
  } finally {
    await instance.dispose();
  }
});
