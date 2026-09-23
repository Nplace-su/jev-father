import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('agent launcher starts a clean checkout, skips unrelated services and reuses its own', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-agent-start-'));
  let pid;
  const unrelated = http.createServer((req, res) => { res.end('unrelated local app'); });
  await new Promise(resolve => unrelated.listen(0, '127.0.0.1', resolve));
  const basePort = unrelated.address().port;
  t.after(async () => {
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    await new Promise(resolve => { unrelated.close(resolve); unrelated.closeAllConnections(); });
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  for (const path of ['server.mjs', 'lib', 'public', 'scripts', 'package.json']) await cp(join(root, path), join(dir, path), { recursive: true });
  const env = { ...process.env, PORT: String(basePort), TYPESAFE_API_KEY: '', GITHUB_TOKEN: '', JEV_NO_OPEN: '1' };
  const run = async () => JSON.parse((await exec(process.execPath, ['scripts/agent-start.mjs'], { cwd: dir, env, timeout: 20_000 })).stdout.trim());
  const first = await run();
  pid = first.pid;
  assert.equal(first.status, 'started');
  assert.ok(Number.isInteger(pid));
  assert.notEqual(new URL(first.url).port, String(basePort));
  assert.deepEqual(await (await fetch(`${first.url}/api/health`)).json(), { app: 'jev-father', status: 'ready' });
  assert.equal((await (await fetch(`${first.url}/api/config`)).json()).configured, false);
  assert.match(await (await fetch(first.url)).text(), /你的 Jev API key/);
  assert.equal((await (await fetch(`${first.url}/api/demo`)).json()).demo, true);
  const second = await run();
  assert.equal(second.status, 'already-running');
  assert.equal(second.url, first.url);
  assert.equal(await (await fetch(`http://127.0.0.1:${basePort}`)).text(), 'unrelated local app');
});
