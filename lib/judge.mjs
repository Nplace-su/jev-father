import { AXES, buildQuestions, buildFinalPayload, readDimensions, makeVerdict } from './rubric.mjs';
import { limitedText, mapConcurrent } from './github.mjs';

export const BATCH_CHARS = 24_000;
const PART_CHARS = 12_000;
const REDUCE_GROUP = 8;

// Partition every character, including long single lines; nothing is excerpted.
export function makeBatches(files, maxChars = BATCH_CHARS) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('Invalid batch size');
  const batches = []; let current = []; let size = 0;
  for (const file of files) {
    let offset = 0; let line = 1;
    do {
      let end = Math.min(file.content.length, offset + Math.min(PART_CHARS, maxChars));
      if (end < file.content.length) {
        const newline = file.content.lastIndexOf('\n', end - 1);
        if (newline >= offset) end = newline + 1;
      }
      const content = file.content.slice(offset, end);
      const newlines = (content.match(/\n/g) ?? []).length;
      const part = { path: file.path, startLine: line, endLine: line + newlines, offset, content };
      if (current.length && size + content.length > maxChars) { batches.push(current); current = []; size = 0; }
      current.push(part); size += content.length; line += newlines; offset = end;
    } while (offset < file.content.length);
  }
  if (current.length) batches.push(current);
  return batches;
}
function commonContext(repo) {
  return {
    scope: '完整读取范围内的源码、文档、配置，按全文分批审阅；未运行代码或核查外部实验。某批未出现不等于仓库不存在，避免把模块片段当作完整项目。',
    repository: repo.fullName, description: repo.description, commit: repo.sha,
    coverage: { read: repo.files.length, eligible: repo.eligibleFiles ?? repo.files.length, total: repo.totalFiles,
      failedFiles: repo.failedFiles, excludedCount: repo.excludedFiles?.length ?? 0 },
    // This repeated preview provides project intent in code-only batches.
    // The complete README is independently included in the ordinary batches.
    untrusted_readme_context: repo.files.filter(f => /(^|\/)readme(?:\.|$)/i.test(f.path))
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path)).slice(0, 2)
      .map(f => ({ path: f.path, content: f.content.slice(0, 4000), previewOnly: f.content.length > 4000 })),
  };
}
export function buildPayload(repo, model = 'jev-latest', parts = repo.files, batch = { index: 1, total: 1 }) {
  return { model, state: { ...commonContext(repo), batch, untrusted_files: parts }, questions: buildQuestions() };
}
function compactDimensions(dimensions) {
  return dimensions.map(d => ({ dimension: d.name, choice: d.choice, judgment: d.reason,
    confidence: d.confidence, probabilities: Object.fromEntries(Object.entries(d.probabilities)
      .map(([choice, probability]) => [AXES.find(a => a.id === d.id).options[choice]?.[0] ?? choice, probability])) }));
}
export function buildMergePayload(repo, entries, model) {
  const questions = buildQuestions();
  for (const question of Object.values(questions)) {
    question.instructions += '\n这是跨批汇总：联合考虑所有批次的线索与概率，保留低置信度判断。局部未涉及不代表项目缺失；许多辅助文件说 unknown 不能淹没关键实现。不是多数票，不能把“单批不能证明完整流程”累加成“整个项目单薄”。只有明确冲突才认定夸大，无法定位的短板仅作为不确定性。';
  }
  return { model, state: { ...commonContext(repo), batch_judgments: entries.map(entry => ({
    sourceFiles: entry.paths, dimensions: compactDimensions(entry.dimensions),
  })) }, questions };
}
export async function judge(repo, { key = process.env.TYPESAFE_API_KEY, model = process.env.JEV_MODEL || 'jev-latest', fetchImpl = fetch, onProgress = () => {} } = {}) {
  if (!key) throw new Error('还没配置 TYPESAFE_API_KEY：复制 .env.example 为 .env，填入密钥后重启。');
  const start = performance.now();
  const call = async payload => {
    const response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(response.status === 401 ? 'Jev 密钥无效或无访问权限。' : `Jev 请求失败（${response.status}），本次未完成评价。`);
    return JSON.parse(await limitedText(response, 200_000));
  };
  const batches = makeBatches(repo.files);
  if (!batches.length) throw new Error('没有可送审的文件。');
  const payloads = []; const raw = []; const stages = [];
  let completed = 0;
  onProgress(`Jev 正在分批阅读全文：0 / ${batches.length} 批`);
  let entries = await mapConcurrent(batches, 3, async (parts, index) => {
    const payload = buildPayload(repo, model, parts, { index: index + 1, total: batches.length });
    const response = await call(payload);
    const dimensions = readDimensions(response);
    onProgress(`Jev 正在分批阅读全文：${++completed} / ${batches.length} 批`);
    return { payload, response, dimensions, paths: [...new Set(parts.map(p => p.path))] };
  });
  // Record in source order, independent of network completion order.
  for (const entry of entries) { payloads.push(entry.payload); raw.push(entry.response); stages.push('read'); }
  let mergeCalls = 0; let level = 0;
  while (entries.length > 1) {
    const groups = [];
    for (let i = 0; i < entries.length; i += REDUCE_GROUP) groups.push(entries.slice(i, i + REDUCE_GROUP));
    onProgress(`Jev 正在跨文件汇总：第 ${++level} 层，${groups.length} 组`);
    entries = await mapConcurrent(groups, 3, async group => {
      if (group.length === 1) return group[0];
      const payload = buildMergePayload(repo, group, model);
      const response = await call(payload);
      const dimensions = readDimensions(response);
      return { payload, response, dimensions, paths: [...new Set(group.flatMap(e => e.paths))], merged: true };
    });
    for (const entry of entries) {
      if (entry.merged) { payloads.push(entry.payload); raw.push(entry.response); stages.push('merge'); mergeCalls++; delete entry.merged; }
    }
  }
  const dimensions = entries[0].dimensions;
  onProgress('Jev 正在终审：从夯、顶级、人上人、NPC、拉中选择档位…');
  const finalPayload = buildFinalPayload(dimensions, model);
  const final = await call(finalPayload);
  payloads.push(finalPayload); raw.push(final); stages.push('verdict');
  const verdict = makeVerdict(dimensions, final);
  return { ...verdict, repo, demo: false, inferenceMs: Math.round(performance.now() - start),
    batchCount: batches.length, mergeCalls, calls: raw.length, stages, payloads, raw };
}
