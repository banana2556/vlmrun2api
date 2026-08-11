import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockUpstream } from './mock-upstream.mjs';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const wrangler = resolve(cwd, 'node_modules/wrangler/bin/wrangler.js');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(url, options, isRunning, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    if (!isRunning()) throw new Error(`Wrangler exited before ${url} was ready`);
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(1000) });
      if (response.status !== 404) return response;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(2000)
  ]);
}

const workerPort = await freePort();
const mockPort = await freePort();
const mock = await startMockUpstream(mockPort);
const worker = spawn(process.execPath, [
  wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(workerPort),
  '--show-interactive-dev-session=false',
  '--var', 'API_KEY:',
  '--var', `UPSTREAM_BASE_URL:http://127.0.0.1:${mockPort}/v1`,
  '--var', `CHAT_COMPLETIONS_URL:http://127.0.0.1:${mockPort}/v1/chat/completions`,
  '--var', `MODEL_ENDPOINT:http://127.0.0.1:${mockPort}/v1/models`,
  '--var', 'DEFAULT_MODEL:e2e-model',
  '--var', 'MODELS:e2e-model',
  '--var', 'VLM_SESSION_TOKEN:'
], {
  cwd,
  env: { ...process.env, CI: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});

let workerOutput = '';
worker.stdout.on('data', (chunk) => { workerOutput += chunk.toString(); });
worker.stderr.on('data', (chunk) => { workerOutput += chunk.toString(); });
let workerRunning = true;
worker.once('exit', () => { workerRunning = false; });

try {
  const health = await waitFor(`http://127.0.0.1:${workerPort}/healthz`, {}, () => workerRunning);
  assert.equal(health.status, 200);

  const models = await fetch(`http://127.0.0.1:${workerPort}/v1/models`);
  assert.equal(models.status, 200);
  assert.equal((await models.json()).data[0].id, 'e2e-model');

  for (let index = 0; index < 2; index += 1) {
    const completion = await fetch(`http://127.0.0.1:${workerPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'e2e-model',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        session_id: 'client-session',
        session_token: 'client-token'
      })
    });
    assert.equal(completion.status, 200);
    const text = await completion.text();
    assert.match(text, /local-ok/);
    assert.match(text, /data: \[DONE\]/);
  }

  const first = mock.requests[0];
  const second = mock.requests[1];
  assert.equal(first.body.model, 'e2e-model');
  assert.match(first.body.session_id, /^[0-9a-f-]{36}$/);
  assert.match(first.body.session_token, /^[0-9a-f]{40}$/);
  assert.match(first.fingerprint, /^[0-9a-f]{32}$/);
  assert.notEqual(first.body.session_id, second.body.session_id);
  assert.notEqual(first.body.session_token, second.body.session_token);
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.notEqual(first.body.session_id, 'client-session');
  assert.notEqual(first.body.session_token, 'client-token');

  console.log('wrangler local E2E passed');
} catch (error) {
  console.error(workerOutput);
  throw error;
} finally {
  await stopProcess(worker);
  await new Promise((resolve) => mock.server.close(resolve));
}
