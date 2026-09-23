import { AXES, buildQuestions, buildFinalPayload, readDimensions, makeVerdict, validateChoice } from './rubric.mjs';
import { limitedText, mapConcurrent } from './github.mjs';
import { prepareFiles } from './prepare.mjs';

export const BATCH_CHARS = 24_000;
const PART_CHARS = 1200;

// All prepared text is partitioned without truncation. Small source IDs allow
// Jev to select actual passages instead of inventing free-form explanations.
export function makeBatches(files, maxChars = BATCH_CHARS) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('Invalid batch size');
  const batches = []; let current = []; let size = 0; let id = 0;
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
      const part = { id: `E${++id}`, path: file.path, representation: file.representation ?? 'full_text', startLine: line, endLine: line + newlines, offset, content };
      if (current.length && (size + content.length > maxChars || current.length >= 80)) { batches.push(current); current = []; size = 0; }
      current.push(part); size += content.length; line += newlines; offset = end;
    } while (offset < file.content.length);
  }
  if (current.length) batches.push(current);
  return batches;
}
function commonContext(repo) {
  return {
    scope: '静态项目材料，不执行代码。README 为作者主张，实验记录为作者提供的数据，均未独立复现；API 与外部组件的能力不等于作者贡献。本批未涉及的维度选 unknown。',
    // Do not repeat README marketing in every batch.
    coverage: { read: repo.files.length, eligible: repo.eligibleFiles ?? repo.files.length,
      failedFiles: repo.failedFiles, excludedCount: repo.excludedFiles?.length ?? 0 },
  };
}
export function buildPayload(repo, model = 'jev-latest', parts = makeBatches(repo.files)[0] ?? [], batch = { index: 1, total: 1 }) {
  const questions = buildQuestions();
  for (const axis of AXES) {
    questions[`${axis.id}_source`] = {
      type: 'choice', instructions: `以下是材料索引选择，不是打分。针对问题「${axis.question}」选本批最有实质依据的一段；优先代码/数据中的支持或反证，不能把无关文件当项目优点；没有相关依据选 none。返回已有段落 ID。`,
      criteria: { none: '本批没有该维度的相关项目证据', ...Object.fromEntries(parts.map(p => [p.id, `${p.path}，${p.representation}，第 ${p.startLine} 至 ${p.endLine} 行`])) },
    };
  }
  return { model, state: { ...commonContext(repo), batch, untrusted_files: parts }, questions };
}

// Group observed choices without re-deciding them. Keep every positive/negative
// category, its probabilities and a verbatim passage. Counts are NOT votes.
export function collectEvidence(entries) {
  return AXES.map(axis => {
    const groups = new Map();
    for (const [index, entry] of entries.entries()) {
      const d = entry.dimensions.find(d => d.id === axis.id);
      if (!groups.has(d.choice)) groups.set(d.choice, { choice: d.choice, meaning: axis.options[d.choice]?.[0] ?? d.choice,
        observations: [], probabilitySums: {}, examples: [] });
      const g = groups.get(d.choice);
      g.observations.push({ batch: index + 1, confidence: d.confidence, selectedProbability: d.probabilities[d.choice] });
      for (const [key, p] of Object.entries(d.probabilities)) g.probabilitySums[key] = (g.probabilitySums[key] ?? 0) + p;
      if (d.evidence) g.examples.push({ ...d.evidence, confidence: d.confidence });
    }
    return { dimension: axis.id, name: axis.name, findings: [...groups.values()].map(g => ({
      choice: g.choice, meaning: g.meaning, count: g.observations.length,
      confidenceRange: [Math.min(...g.observations.map(o => o.confidence)), Math.max(...g.observations.map(o => o.confidence))],
      meanDistribution: Object.fromEntries(Object.entries(g.probabilitySums).map(([k, p]) => [k, Number((p / g.observations.length).toFixed(4))])),
      batches: g.observations.map(o => o.batch),
      // One strongest source per distinct choice keeps the review bounded while
      // retaining both sides. All other passages/responses remain in the export.
      evidence: g.examples.sort((a, b) => b.confidence - a.confidence).slice(0, 1),
    })) };
  });
}
export function buildMergePayload(repo, evidence, model) {
  const questions = buildQuestions();
  for (const question of Object.values(questions)) question.instructions += '\n这是唯一一次全项目复核。source_evidence 按每个不同判断保留支持和反对的原文；模型标签不是事实，批次数不是独立样本，不得投票。结合原文判断分歧，低置信度反证仍需考虑。完成度不能覆盖适配性缺陷，没有合理基线的收益不能被汇总成有收益。不要因重复肯定而增加确定性。';
  return { model, state: { ...commonContext(repo), source_evidence: evidence }, questions };
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
  const prepared = prepareFiles(repo.files);
  const batches = makeBatches(prepared.files);
  if (!batches.length) throw new Error('只有外部背景材料，没有本项目可送审内容。');
  const payloads = []; const raw = []; const stages = [];
  let completed = 0;
  onProgress(`准备完成：${prepared.manifest.filter(f => f.treatment === 'background').length} 份外部背景、${prepared.manifest.filter(f => f.treatment === 'duplicate').length} 份重复文件不重复评分；共 ${batches.length} 批`);
  const entries = await mapConcurrent(batches, 3, async (parts, index) => {
    const payload = buildPayload(repo, model, parts, { index: index + 1, total: batches.length });
    const response = await call(payload);
    const dimensions = readDimensions(response);
    for (const d of dimensions) {
      const name = `${d.id}_source`;
      const answer = validateChoice(response.answers?.[name], payload.questions[name], name);
      const source = parts.find(p => p.id === answer.choice);
      d.evidence = source ? { ...source, selectionConfidence: answer.confidence } : null;
    }
    onProgress(`Jev 正在审阅项目材料：${++completed} / ${batches.length} 批`);
    return { payload, response, dimensions };
  });
  for (const e of entries) { payloads.push(e.payload); raw.push(e.response); stages.push('read'); }
  const evidence = collectEvidence(entries);
  let dimensions = entries[0].dimensions; let mergeCalls = 0;
  if (entries.length > 1) {
    onProgress('Jev 正在进行一次全项目复核：保留正反判断和来源片段…');
    const payload = buildMergePayload(repo, evidence, model);
    const response = await call(payload);
    dimensions = readDimensions(response);
    payloads.push(payload); raw.push(response); stages.push('merge'); mergeCalls = 1;
  }
  onProgress('Jev 正在终审：按新增价值和实证收益选择五档…');
  const finalPayload = buildFinalPayload(dimensions, model, evidence);
  const final = await call(finalPayload);
  payloads.push(finalPayload); raw.push(final); stages.push('verdict');
  const verdict = makeVerdict(dimensions, final);
  const usage = raw.reduce((sum, r) => ({ input_tokens: sum.input_tokens + (r.usage?.input_tokens ?? 0), output_tokens: sum.output_tokens + (r.usage?.output_tokens ?? 0) }), { input_tokens: 0, output_tokens: 0 });
  return { ...verdict, usage, repo, demo: false, inferenceMs: Math.round(performance.now() - start),
    preparation: { ...prepared, files: undefined }, evidence,
    batchCount: batches.length, mergeCalls, calls: raw.length, stages, payloads, raw };
}
