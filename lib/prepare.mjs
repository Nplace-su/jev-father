import { createHash } from 'node:crypto';

const BACKGROUND = /(^|\/)(?:context\/sources|docs\/sources|third[_-]party|external|vendor)(\/|$)/i;
const GROUP_KEYS = ['exp', 'fmt', 'n', 'n_opts', 'size', 'nq', 'variant', 'method', 'model', 'controller', 'policy', 'task', 'condition', 'mode'];
const METRIC = /latency|upstream|duration|tokens|success|reward|confidence|score|rate|steps|distance|error/i;

// Every valid row contributes. Raw logs remain in repo.files and in the export.
// These are descriptive statistics, never a claimed causal improvement.
export function summarizeJsonl(content) {
  let rows;
  try { rows = content.split('\n').filter(l => l.trim()).map(line => JSON.parse(line)); }
  catch { return null; }
  if (!rows.length || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) return null;
  const groupMap = new Map();
  let mixedMetricTypes = false;
  for (const row of rows) {
    const condition = Object.fromEntries(GROUP_KEYS.filter(k => row[k] !== undefined && ['string', 'number', 'boolean'].includes(typeof row[k])).map(k => [k, row[k]]));
    const key = JSON.stringify(condition);
    // Too many heterogeneous cases: use the original full text instead.
    if (!groupMap.has(key) && groupMap.size >= 60) return null;
    if (!groupMap.has(key)) groupMap.set(key, { condition, count: 0, statuses: {}, errors: 0, metrics: {}, truthComparisons: {} });
    const g = groupMap.get(key); g.count++;
    if (row.status !== undefined) g.statuses[String(row.status)] = (g.statuses[String(row.status)] ?? 0) + 1;
    if (row.err || row.error || (typeof row.status === 'number' && row.status >= 400)) g.errors++;
    function visit(value, path = '') {
      if (typeof value === 'number' && Number.isFinite(value) && METRIC.test(path) && !path.includes('.probabilities.')) {
        const m = g.metrics[path] ??= { count: 0, sum: 0, min: value, max: value };
        if (!('sum' in m)) { mixedMetricTypes = true; return; }
        m.count++; m.sum += value; m.min = Math.min(m.min, value); m.max = Math.max(m.max, value);
      } else if (typeof value === 'boolean') {
        const m = g.metrics[path] ??= { count: 0, trueCount: 0 };
        if (!('trueCount' in m)) { mixedMetricTypes = true; return; }
        m.count++; m.trueCount += Number(value);
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key);
      }
    }
    visit(row);
    for (const [name, truth] of Object.entries(row.truth ?? {})) {
      const answer = row.body?.answers?.[name]?.choice;
      if (answer !== undefined && ['string', 'number', 'boolean'].includes(typeof truth)) {
        const metric = g.truthComparisons[name] ??= { compared: 0, equal: 0 };
        metric.compared++; metric.equal += Number(answer === truth);
      }
    }
  }
  if (mixedMetricTypes) return null;
  const groups = [...groupMap.values()].map(g => ({ ...g, metrics: Object.fromEntries(Object.entries(g.metrics).map(([k, m]) => [k, 'sum' in m ? { count: m.count, mean: m.sum / m.count, min: m.min, max: m.max } : m])) }));
  const result = {
    representation: 'deterministic_summary_of_all_jsonl_rows', rows: rows.length, groups,
    limits: '全行参与统计。不同实验条件分组；truthComparisons 仅做提供的 truth 与 choice 精确相等计数。没有测量系统收益、因果增益或概率校准。字符串细节和原始分布不在统计中；以下仅为首尾与错误记录示例，原始文件完整保留。',
    examples: [...new Set([0, rows.length - 1, rows.findIndex(r => r.err || r.error || (typeof r.status === 'number' && r.status >= 400))])].filter(i => i >= 0).map(i => ({ line: i + 1, record: rows[i] })),
  };
  const summary = JSON.stringify(result);
  return summary.length < content.length * 0.7 ? summary : null;
}

export function prepareFiles(files) {
  const seen = new Map(); const prepared = []; const manifest = [];
  for (const file of files) {
    if (BACKGROUND.test(file.path)) { manifest.push({ path: file.path, treatment: 'background', reason: '收录的外部资料，不用作项目实现或增益证据' }); continue; }
    const hash = createHash('sha256').update(file.content).digest('hex');
    if (seen.has(hash)) { manifest.push({ path: file.path, treatment: 'duplicate', duplicateOf: seen.get(hash) }); continue; }
    seen.set(hash, file.path);
    const summary = /\.jsonl$/i.test(file.path) && file.content.length > 30_000 ? summarizeJsonl(file.content) : null;
    prepared.push({ ...file, content: summary ?? file.content, representation: summary ? 'all_rows_statistics' : 'full_text' });
    manifest.push({ path: file.path, treatment: summary ? 'all_rows_statistics' : 'full_text', originalChars: file.content.length, submittedChars: (summary ?? file.content).length });
  }
  return { files: prepared, manifest, originalChars: files.reduce((n, f) => n + f.content.length, 0), submittedChars: prepared.reduce((n, f) => n + f.content.length, 0) };
}
