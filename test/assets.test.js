import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {after, before, test} from 'node:test';

const indexBytes = await readFile('public/index.html');
const assetHeaders = {
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-cache',
};
let server;
let baseUrl;
let serverOutput = '';
let persistPath;

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolvePromise, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolvePromise);
  });
  const {port} = listener.address();
  await new Promise(resolvePromise => listener.close(resolvePromise));
  return port;
}

before(async () => {
  const port = await unusedPort();
  persistPath = await mkdtemp(join(tmpdir(), 'trustless-txt-wrangler-'));
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [
    resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local',
    '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persistPath,
    '--log-level', 'error',
  ], {cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe']});
  server.stdout.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
  server.stderr.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });

  let lastError;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error(`wrangler dev exited early\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/`, {signal: AbortSignal.timeout(500)});
      if (response.status === 200) return;
      lastError = new Error(`Unexpected startup response ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  throw new Error(`wrangler dev did not become ready: ${lastError}\n${serverOutput}`);
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolvePromise => {
      const timeout = setTimeout(resolvePromise, 2000);
      server.once('exit', () => { clearTimeout(timeout); resolvePromise(); });
    });
  }
  if (persistPath) await rm(persistPath, {recursive: true, force: true});
});

test('root and SPA fallback serve the exact HTML bytes with security headers', async () => {
  const paths = ['/', '/AbCdEf0123_-xyZ9'];
  for (const path of paths) {
    const response = await fetch(`${baseUrl}${path}`, {headers: {'Sec-Fetch-Mode': 'navigate'}});
    assert.equal(response.status, 200, path);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, indexBytes, path);
    for (const [header, value] of Object.entries(assetHeaders)) {
      assert.equal(response.headers.get(header), value, `${path} ${header}`);
    }
  }
});
