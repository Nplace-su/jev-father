import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';

async function fixture(t, options = {}) {
  const calls = [];
  const server = createApp({
    collect: async url => { calls.push({ stage: 'collect', url }); return { fullName: 'fixture/repo' }; },
    evaluate: async (repo, opts) => { calls.push({ stage: 'judge', key: opts.key }); opts.onProgress('fixture progress'); return { repo, label: 'NPC' }; },
    ...options,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/api/judge`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { base, post, calls };
}
const url = 'https://github.com/fixture/repo';

test('page key is used only for that request and never returned or retained', async t => {
  const f = await fixture(t);
  const first = await f.post({ url, apiKey: 'ephemeral-fixture-key' }, { Accept: 'application/x-ndjson' });
  assert.equal(first.status, 200);
  const body = await first.text();
  assert.ok(body.includes('"type":"result"'));
  assert.ok(body.includes('fixture progress'));
  assert.ok(!body.includes('ephemeral-fixture-key'));
  assert.deepEqual(f.calls.at(-1), { stage: 'judge', key: 'ephemeral-fixture-key' });
  const config = await (await fetch(`${f.base}/api/config`)).json();
  assert.deepEqual(config, { configured: false, model: 'jev-latest' });
  const next = await f.post({ url });
  assert.equal(next.status, 400);
  assert.equal(f.calls.length, 2);
});

test('page key overrides configured key without modifying the fallback', async t => {
  const f = await fixture(t, { configuredKey: 'configured-fixture-key' });
  assert.equal((await f.post({ url, apiKey: 'page-fixture-key' })).status, 200);
  assert.equal(f.calls.at(-1).key, 'page-fixture-key');
  assert.equal((await f.post({ url })).status, 200);
  assert.equal(f.calls.at(-1).key, 'configured-fixture-key');
  const config = await (await fetch(`${f.base}/api/config`)).text();
  assert.ok(!config.includes('configured-fixture-key'));
});

test('invalid keys and foreign origins fail before any provider request', async t => {
  const f = await fixture(t);
  for (const apiKey of [42, {}, 'x\nheader', 'x'.repeat(1025)]) {
    assert.equal((await f.post({ url, apiKey })).status, 400);
  }
  assert.equal((await f.post({ url, apiKey: 'fixture-key' }, { Origin: 'https://untrusted.example' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(`${f.base}/api/config`, { headers: { Host: 'untrusted.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal(f.calls.length, 0);
});

test('provider failure does not retain the submitted key', async t => {
  const f = await fixture(t, { evaluate: async () => { throw Error('upstream unavailable'); } });
  const response = await f.post({ url, apiKey: 'failure-fixture-key' }, { Accept: 'application/x-ndjson' });
  const body = await response.text();
  assert.ok(body.includes('"type":"error"'));
  assert.ok(!body.includes('failure-fixture-key'));
  assert.equal((await f.post({ url })).status, 400);
});
