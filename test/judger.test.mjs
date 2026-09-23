import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRepo, selectFiles, collectRepo, exclusionReason, mapConcurrent } from '../lib/github.mjs';
import { buildQuestions, FINAL_QUESTION, readDimensions, buildFinalPayload, makeVerdict } from '../lib/rubric.mjs';
import { judge, makeBatches, buildPayload } from '../lib/judge.mjs';
import { prepareFiles, summarizeJsonl } from '../lib/prepare.mjs';
import { demoResult, sampleAnswer } from '../lib/demo.mjs';

function mockResponse(payload, { fit } = {}) {
  const fixture = demoResult();
  return { model: 'test', usage: { input_tokens: 10, output_tokens: 2 }, answers: Object.fromEntries(Object.entries(payload.questions).map(([id, q]) => {
    const choice = id === 'tier' ? '人上人' : id.endsWith('_source') ? (Object.keys(q.criteria).find(k => k !== 'none') ?? 'none') : id === 'fit' && fit ? fit : fixture.raw[0].answers[id].choice;
    return [id, sampleAnswer(q, choice)];
  })) };
}
test('only accepts public GitHub repository URL shape', () => {
  assert.equal(parseRepo('https://github.com/abc/project.git/').fullName, 'abc/project');
  for (const url of ['http://localhost/a/b', 'https://github.com.evil.test/a/b', 'https://user@github.com/a/b', 'https://github.com/a/b/tree/main', 'https://github.com/a/..', 'https://github.com/a/b?x=1']) assert.throws(() => parseRepo(url));
});
test('selects all relevant files beyond eight, with explicit exclusions', () => {
  const blob = (path, extra = {}) => ({ path, type: 'blob', mode: '100644', size: 100, ...extra });
  const files = [...Array.from({ length: 15 }, (_, i) => blob(`src/module${i}.py`)), blob('README.md'), blob('Dockerfile'), blob('robot.urdf'), blob('metrics.csv'), blob('large.py', { size: 300000 })];
  const omitted = [blob('vendor/jev.py'), blob('.env'), blob('secret.py', { mode: '120000' }), blob('huge.py', { size: 2000000 }), blob('model.safetensors')];
  assert.equal(selectFiles([...files, ...omitted]).length, files.length);
  assert.equal(selectFiles(files)[0].path, 'README.md');
  for (const file of omitted) assert.ok(exclusionReason(file));
});
test('batching preserves every character, long lines and the last file', () => {
  const files = [...Array.from({ length: 12 }, (_, i) => ({ path: `src/${i}.py`, content: `FILE_${i}\n` + 'a'.repeat(1000) + `\nTAIL_${i}` })), { path: 'empty.py', content: '' }];
  const batches = makeBatches(files, 333);
  for (const batch of batches) assert.ok(batch.reduce((n, p) => n + p.content.length, 0) <= 333);
  for (const file of files) {
    const parts = batches.flat().filter(p => p.path === file.path);
    assert.equal(parts.map(p => p.content).join(''), file.content);
    let offset = 0;
    for (const part of parts) { assert.equal(part.offset, offset); offset += part.content.length; }
  }
});
test('low confidence keeps judgment and distribution available for final Choice', () => {
  const first = structuredClone(demoResult().raw[0]);
  first.answers.fit.confidence = 0.1;
  first.answers.robotics = sampleAnswer(buildQuestions().robotics, 'not_applicable');
  const dimensions = readDimensions(first);
  const payload = buildFinalPayload(dimensions);
  assert.equal(payload.state.fitKnown, true);
  assert.notEqual(payload.state.dimensions[0].judgment, 'unknown');
  assert.equal(payload.state.dimensions[0].uncertain, true);
  assert.ok(payload.state.dimensions[0].candidates.length > 1);
  assert.equal(payload.state.dimensions[4].judgment, '不适用');
});
test('README is read once and not repeated as marketing context', () => {
  const files = ['examples/README.md', 'README.md', 'README.zh-CN.md']
    .map(path => ({ path, type: 'blob', mode: '100644', size: 9000, content: 'x'.repeat(9000) }));
  assert.equal(selectFiles(files)[0].path, 'README.md');
  const payload = buildPayload({ ...demoResult().repo, files });
  assert.equal(payload.state.untrusted_readme_context, undefined);
  assert.equal(makeBatches(files).flat().filter(p => p.path === 'README.md').map(p => p.content).join('').length, 9000);
  assert.ok(payload.questions.fit_source);
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
test('final tier comes directly from the final Choice, never a weighted score', () => {
  const demo = demoResult();
  const final = { model: 'test', answers: { tier: sampleAnswer(FINAL_QUESTION, 'NPC') } };
  assert.equal(makeVerdict(demo.dimensions, final).label, 'NPC');
});
test('real close-choice response is retained instead of rejected or relabeled', () => {
  const first = structuredClone(demoResult().raw[0]);
  first.answers.substance = { type: 'choice', choice: 'unknown', confidence: 0.31,
    probabilities: { unknown: 0.44, working: 0.08, empty: 0.01, thin: 0.02, solid: 0.45 } };
  const dimension = readDimensions(first).find(d => d.id === 'substance');
  assert.equal(dimension.choice, 'unknown');
  assert.equal(dimension.probabilities.solid, 0.45);
  assert.equal(dimension.distributionDisagrees, true);
  assert.equal(dimension.uncertain, true);
  const verdict = makeVerdict([], { answers: { tier: { type: 'choice', choice: '顶级', confidence: 0.7,
    probabilities: { '夯': 0, '顶级': 0.44, '人上人': 0.45, 'NPC': 0.11, '拉': 0 } } } });
  assert.equal(verdict.label, '顶级');
  assert.equal(verdict.uncertain, true);
});
test('small repository needs only read and final requests without exposing the key', async () => {
  const demo = demoResult(); const calls = [];
  const output = await judge(demo.repo, { key: 'secret-fixture-key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    calls.push(JSON.parse(options.body));
    return Response.json(mockResponse(calls.at(-1)));
  } });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].state.untrusted_files);
  assert.equal(calls[1].state.availableDimensions, 5);
  assert.deepEqual(Object.keys(calls[1].questions), ['tier']);
  assert.equal(output.label, '人上人');
  assert.equal(output.usage.input_tokens, calls.length * 10);
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
  assert.equal(result.eligibleFiles, 2);
  assert.equal(result.files[0].content, '# README\nDemo');
  assert.equal(result.files[0].excerpted, false);
});
test('missing key never calls the provider', async () => {
  await assert.rejects(judge(demoResult().repo, { key: '', fetchImpl: () => assert.fail('called provider') }), /TYPESAFE_API_KEY/);
});

test('final Choice has exactly five tiers even when all dimensions are unknown', () => {
  assert.deepEqual(Object.keys(FINAL_QUESTION.criteria), ['夯', '顶级', '人上人', 'NPC', '拉']);
  const answers = Object.fromEntries(Object.entries(buildQuestions()).map(([id, q]) => [id, sampleAnswer(q, 'unknown')]));
  const dimensions = readDimensions({ answers });
  const verdict = makeVerdict(dimensions, { answers: { tier: sampleAnswer(FINAL_QUESTION, 'NPC') } });
  assert.equal(verdict.label, 'NPC');
  assert.equal(verdict.uncertain, true);
  assert.equal(Object.keys(verdict.probabilities).length, 5);
});
test('one global review preserves opposing judgments and real evidence across all batches', async () => {
  const demo = demoResult();
  const files = Array.from({ length: 18 }, (_, i) => ({ path: `file${i}.py`, content: `BEGIN_${i}\n` + 'x'.repeat(24000) + `\nEND_${i}` }));
  const calls = []; const progress = [];
  const output = await judge({ ...demo.repo, files, eligibleFiles: 18 }, { key: 'test', onProgress: s => progress.push(s), fetchImpl: async (_, options) => {
    const payload = JSON.parse(options.body); calls.push(payload);
    return Response.json(mockResponse(payload, { fit: payload.state.batch?.index % 2 === 0 ? 'awkward' : 'native' }));
  } });
  const reads = calls.filter(c => c.state.untrusted_files);
  const merges = calls.filter(c => c.state.source_evidence && !c.questions.tier);
  assert.ok(reads.length > 8);
  assert.equal(merges.length, 1);
  for (const file of files) assert.equal(reads.flatMap(p => p.state.untrusted_files).filter(p => p.path === file.path).map(p => p.content).join(''), file.content);
  const findings = merges[0].state.source_evidence.find(d => d.dimension === 'fit').findings;
  assert.deepEqual(new Set(findings.map(f => f.choice)), new Set(['native', 'awkward']));
  for (const f of findings) assert.ok(f.evidence[0].path && f.evidence[0].content);
  assert.deepEqual(calls.at(-1).state.source_evidence, merges[0].state.source_evidence);
  assert.equal(calls.at(-1).questions.tier.type, 'choice');
  assert.equal(output.calls, calls.length);
  assert.equal(output.payloads.length, output.raw.length);
  assert.equal(output.stages.filter(s => s === 'read').length, output.batchCount);
  assert.equal(output.stages.filter(s => s === 'merge').length, output.mergeCalls);
  assert.equal(output.label, '人上人');
  assert.equal(output.usage.input_tokens, calls.length * 10);
  assert.ok(progress.some(s => s.includes('终审')));
});
test('read failure aborts instead of returning a fabricated five-tier result', async () => {
  await assert.rejects(judge(demoResult().repo, { key: 'test', fetchImpl: async () => new Response('', { status: 429 }) }), /429/);
});
test('truncated GitHub tree fails before evaluating an incomplete selection', async () => {
  await assert.rejects(collectRepo('https://github.com/demo/repo', { token: 'test', fetchImpl: async url => {
    if (url.includes('/git/trees/')) return Response.json({ truncated: true, tree: [] });
    if (url.includes('/commits/')) return Response.json({ sha: 'a'.repeat(40) });
    return Response.json({ default_branch: 'main', private: false });
  } }), /目录不完整/);
});
test('bounded concurrency preserves source order', async () => {
  let active = 0; let peak = 0;
  const result = await mapConcurrent([0,1,2,3,4,5,6], 3, async i => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, (7 - i) * 2));
    active--; return i;
  });
  assert.ok(peak <= 3);
  assert.deepEqual(result, [0,1,2,3,4,5,6]);
});

test('preparation separates external references, deduplicates files and retains own docs', () => {
  const prepared = prepareFiles([
    { path: 'context/sources/vendor.md', content: 'An external vendor claims speed' },
    { path: 'context/experiment.md', content: 'Our experiment and caveats' },
    { path: 'src/policy.py', content: 'implementation' },
    { path: 'archive/policy.py', content: 'implementation' },
  ]);
  assert.deepEqual(prepared.files.map(f => f.path), ['context/experiment.md', 'src/policy.py']);
  assert.equal(prepared.manifest.find(f => f.path === 'archive/policy.py').duplicateOf, 'src/policy.py');
  assert.equal(prepared.manifest.find(f => f.path.startsWith('context/sources')).treatment, 'background');
});
test('log summaries include every row, outliers, errors and separate conditions', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ method: i < 100 ? 'jev' : 'rule', latency_ms: i === 50 ? 10000 : 10, status: i === 50 ? 500 : 200, err: i === 50 ? 'failure' : null, padding: 'x'.repeat(300), truth: { outcome: 'yes' }, body: { answers: { outcome: { choice: i === 50 ? 'no' : 'yes' } } } }));
  const summary = JSON.parse(summarizeJsonl(rows.map(r => JSON.stringify(r)).join('\n')));
  assert.equal(summary.rows, 200);
  assert.equal(summary.groups.length, 2);
  const g = summary.groups.find(g => g.condition.method === 'jev');
  assert.equal(g.count, 100);
  assert.equal(g.errors, 1);
  assert.equal(g.metrics.latency_ms.max, 10000);
  assert.equal(g.metrics.latency_ms.mean, 109.9);
  assert.deepEqual(g.truthComparisons.outcome, { compared: 100, equal: 99 });
  assert.ok(summary.examples.some(e => e.line === 51));
  assert.equal(summarizeJsonl('{invalid}'), null);
});
test('source Choice cannot cite a made-up passage', async () => {
  await assert.rejects(judge(demoResult().repo, { key: 'test', fetchImpl: async (_, opts) => {
    const payload = JSON.parse(opts.body); const response = mockResponse(payload);
    response.answers.fit_source.choice = 'made-up';
    return Response.json(response);
  } }), /fit_source/);
});

test('heterogeneous metric types fall back to original logs', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ success: i % 2 ? true : 1, padding: 'x'.repeat(300) }));
  assert.equal(summarizeJsonl(rows.map(r => JSON.stringify(r)).join('\n')), null);
});
