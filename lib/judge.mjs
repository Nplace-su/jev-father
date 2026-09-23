import { buildQuestions, buildFinalPayload, readDimensions, makeVerdict } from './rubric.mjs';
import { limitedText } from './github.mjs';

export function buildPayload(repo, model = 'jev-latest') {
  return { model, state: {
    scope: '公开 GitHub 仓库静态抽样，未运行项目、未核查外部链接、未进行全网新颖性检索。文件缺失或截断不能证明功能不存在。',
    repository: repo.fullName, description: repo.description, commit: repo.sha,
    coverage: { sampled: repo.files.length, total: repo.totalFiles, treeTruncated: repo.treeTruncated, failedFiles: repo.failedFiles },
    untrusted_files: repo.files.map(({ path, content, excerpted }) => ({ path, content, excerpted })),
  }, questions: buildQuestions() };
}
export async function judge(repo, { key = process.env.TYPESAFE_API_KEY, model = process.env.JEV_MODEL || 'jev-latest', fetchImpl = fetch } = {}) {
  if (!key) throw new Error('还没配置 TYPESAFE_API_KEY：复制 .env.example 为 .env，填入密钥后重启。');
  const payload = buildPayload(repo, model);
  const start = performance.now();
  const call = async body => {
  const response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'Jev 密钥无效或无访问权限。' : `Jev 请求失败（${response.status}），请稍后重试。`);
  return JSON.parse(await limitedText(response, 200_000));
  };
  const first = await call(payload);
  const dimensions = readDimensions(first);
  const finalPayload = buildFinalPayload(dimensions, model);
  const final = await call(finalPayload);
  const verdict = makeVerdict(dimensions, final);
  return { ...verdict, repo, demo: false, inferenceMs: Math.round(performance.now() - start),
    payloads: [payload, finalPayload], raw: [first, final] };
}
