import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRepo, selectFiles, excerpt, collectRepo } from '../lib/github.mjs';
import { buildQuestions, FINAL_QUESTION, readDimensions, buildFinalPayload, makeVerdict } from '../lib/rubric.mjs';
import { judge } from '../lib/judge.mjs';
import { demoResult, sampleAnswer } from '../lib/demo.mjs';

test('only accepts public GitHub repository URL shape', () => {
  assert.equal(parseRepo('https://github.com/abc/project.git/').fullName, 'abc/project');
  for (const url of ['http://localhost/a/b', 'https://github.com.evil.test/a/b', 'https://user@github.com/a/b', 'https://github.com/a/b/tree/main', 'https://github.com/a/..', 'https://github.com/a/b?x=1']) assert.throws(() => parseRepo(url));
});
test('samples useful files; skips symlinks, vendor code and oversized files', () => {
  const blob = (path, extra = {}) => ({ path, type: 'blob', mode: '100644', size: 100, ...extra });
  const selected = selectFiles([blob('src/jev.ts'), blob('README.md'), blob('vendor/jev.py'), blob('secret.py', { mode: '120000' }), blob('huge.py', { size: 300000 })]);
  assert.deepEqual(selected.map(f => f.path), ['README.md', 'src/jev.ts']);
});
test('excerpts keep line numbers around Jev calls and stay bounded', () => {
  const lines = Array.from({ length: 600 }, (_, i) => i === 350 ? 'client.system_one(state=observations)' : `line ${i}`);
  const result = excerpt(lines.join('\n'), 'main.py');
  assert.match(result.content, /351: client.system_one/);
  assert.ok(result.excerpted);
  assert.ok(result.content.length <= 6200);
});
test('low confidence and non-applicable results do not become negative evidence', () => {
  const first = structuredClone(demoResult().raw[0]);
  first.answers.fit.confidence = 0.1;
  first.answers.robotics = sampleAnswer(buildQuestions().robotics, 'not_applicable');
  const dimensions = readDimensions(first);
  const payload = buildFinalPayload(dimensions);
  assert.equal(payload.state.fitKnown, false);
  assert.equal(payload.state.dimensions[0].judgment, 'unknown');
  assert.equal(payload.state.dimensions[4].judgment, '不适用');
});
test('invalid API decisions fail instead of fabricating a verdict', () => {
  const first = structuredClone(demoResult().raw[0]);
  first.answers.fit.choice = 'made_up';
  assert.throws(() => readDimensions(first), /协议/);
  first.answers.fit = sampleAnswer(buildQuestions().fit, 'native');
  first.answers.fit.probabilities.native = 50;
  assert.throws(() => readDimensions(first), /概率/);
  assert.throws(() => makeVerdict([], { answers: {} }), /协议/);
});
test('final tier comes directly from the second Choice, never a weighted score', () => {
  const demo = demoResult();
  const final = { model: 'test', answers: { tier: sampleAnswer(FINAL_QUESTION, 'NPC') } };
  assert.equal(makeVerdict(demo.dimensions, final).label, 'NPC');
});
test('real adapter chains exactly two native requests without exposing key in output', async () => {
  const demo = demoResult(); const calls = [];
  const output = await judge(demo.repo, { key: 'secret-fixture-key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify(demo.raw[calls.length - 1]));
  } });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].state.untrusted_files);
  assert.equal(calls[1].state.availableDimensions, 5);
  assert.deepEqual(Object.keys(calls[1].questions), ['tier']);
  assert.equal(output.label, '顶级');
  assert.ok(!JSON.stringify(output).includes('secret-fixture-key'));
});
test('GitHub collection pins raw files to commit and keeps read failures visible', async () => {
  const sha = 'a'.repeat(40); const urls = [];
  const result = await collectRepo('https://github.com/demo/repo', { token: 'test-token', fetchImpl: async (url, opts) => {
    urls.push(url);
    if (url.includes('raw.githubusercontent.com')) {
      assert.ok(url.includes(sha)); assert.equal(opts.headers, undefined);
      return url.endsWith('README.md') ? new Response('# README\nDemo') : new Response('', { status: 404 });
    }
    if (url.includes('/git/trees/')) return Response.json({ tree: [ { path: 'README.md', type: 'blob', mode: '100644', size: 20 }, { path: 'jev.py', type: 'blob', mode: '100644', size: 20 } ], truncated: false });
    if (url.includes('/commits/')) return Response.json({ sha });
    return Response.json({ default_branch: 'main', private: false });
  } });
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.failedFiles, ['jev.py']);
  assert.equal(result.sha, sha);
});
test('missing key never calls the provider', async () => {
  await assert.rejects(judge(demoResult().repo, { key: '', fetchImpl: () => assert.fail('called provider') }), /TYPESAFE_API_KEY/);
});
