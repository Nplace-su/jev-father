const TEXT_EXT = /\.(md|mdx|txt|py|js|jsx|ts|tsx|mjs|cjs|json|toml|ya?ml|rs|go|cpp|hpp|cc|c|h|sh)$/i;
const EXCLUDE = /(^|\/)(node_modules|vendor|dist|build|\.git|\.venv|venv|__pycache__)(\/|$)|(^|\/)(package-lock\.json|.*\.lock|min\.js)|\.min\.js$/i;
export function parseRepo(input) {
  if (typeof input !== 'string' || input.length > 300) throw new Error('请输入 GitHub 仓库链接。');
  const match = input.trim().match(/^https:\/\/github\.com\/([a-z\d](?:[a-z\d-]{0,38}))\/([a-z\d_.-]{1,100})\/?$/i);
  if (!match) throw new Error('请粘贴仓库首页：https://github.com/作者/项目（暂不支持子目录链接）。');
  const repo = match[2].replace(/\.git$/, '');
  if (!repo || repo === '.' || repo === '..') throw new Error('仓库名称无效。');
  return { owner: match[1], repo, fullName: `${match[1]}/${repo}` };
}
export async function limitedText(response, max = 200_000) {
  if (Number(response.headers.get('content-length')) > max) throw new Error('远程文件超过读取上限。');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > max) throw new Error('远程文件超过读取上限。'); chunks.push(Buffer.from(value)); }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}
function priority(path) {
  let score = 0;
  if (/(^|\/)readme\.(md|txt|mdx)$/i.test(path)) score += 100;
  if (/jev|typesafe|system.?one/i.test(path)) score += 65;
  if (/agent|policy|controller|decision|planner|main|app|server/i.test(path)) score += 30;
  if (/test|eval|benchmark|ablation/i.test(path)) score += 25;
  if (/package\.json|pyproject|requirements/i.test(path)) score += 18;
  return score - path.split('/').length * 2;
}
export function selectFiles(tree) {
  const files = tree.filter(f => f.type === 'blob' && f.mode !== '120000' && f.size <= 160_000 && TEXT_EXT.test(f.path) && !EXCLUDE.test(f.path));
  return files.sort((a, b) => priority(b.path) - priority(a.path) || a.path.localeCompare(b.path)).slice(0, 8);
}
export function excerpt(text, path) {
  const lines = text.split('\n');
  const selected = new Set();
  const add = (start, end) => { for (let i = Math.max(0, start); i < Math.min(lines.length, end); i++) selected.add(i); };
  add(0, /readme/i.test(path) ? 110 : 35);
  let hits = 0;
  for (let i = 0; i < lines.length && hits < 10; i++) {
    if (/jev|typesafe|system_one|systemOne|systemone|criteria|baseline|ablation/i.test(lines[i])) { add(i - 6, i + 18); hits++; }
  }
  let content = ''; let previous = -1; let included = 0;
  for (const i of [...selected].sort((a, b) => a - b)) {
    const row = `${i > previous + 1 ? '…\n' : ''}${i + 1}: ${lines[i]}\n`;
    if (content.length + row.length > 6200) break;
    content += row; previous = i; included++;
  }
  return { content, totalLines: lines.length, excerpted: included < lines.length };
}
export async function collectRepo(input, { fetchImpl = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  const { fullName } = parseRepo(input);
  token ||= await githubToken();
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'jev-judger/0.1', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const api = async path => {
    const res = await fetchImpl(`https://api.github.com/repos/${fullName}${path}`, { headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(res.status === 404 ? '仓库不存在，或不是公开仓库。' : [403, 429].includes(res.status) ? 'GitHub 限流或拒绝访问；可在 .env 配置 GITHUB_TOKEN。' : `GitHub 读取失败（${res.status}）。`);
    return JSON.parse(await limitedText(res, 8_000_000));
  };
  const metadata = await api('');
  if (metadata.private) throw new Error('娱乐法庭目前只受理公开仓库。');
  const commit = await api(`/commits/${encodeURIComponent(metadata.default_branch)}`);
  if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error('GitHub 未返回有效的 commit。');
  const listing = await api(`/git/trees/${commit.sha}?recursive=1`);
  if (!Array.isArray(listing.tree)) throw new Error('无法读取仓库目录。');
  const selected = selectFiles(listing.tree);
  const settled = await Promise.allSettled(selected.map(async f => {
    const path = f.path.split('/').map(encodeURIComponent).join('/');
    const response = await fetchImpl(`https://raw.githubusercontent.com/${fullName}/${commit.sha}/${path}`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`文件读取失败（${response.status}）`);
    const text = await limitedText(response, 170_000);
    if (text.includes('\0')) throw new Error('跳过二进制内容');
    return { path: f.path, url: `https://github.com/${fullName}/blob/${commit.sha}/${path}`, ...excerpt(text, f.path) };
  }));
  const files = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!files.length) throw new Error('没有读到可评价的文本或代码文件。');
  return { fullName, url: `https://github.com/${fullName}`, sha: commit.sha,
    description: metadata.description ?? '', files, treeTruncated: !!listing.truncated,
    totalFiles: listing.tree.filter(f => f.type === 'blob').length,
    failedFiles: settled.flatMap((r, i) => r.status === 'rejected' ? [selected[i].path] : []),
    sampledAt: new Date().toISOString(),
  };
}
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
async function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  // Reuse the user's existing GitHub CLI login in memory; never persist or log it.
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 5000, maxBuffer: 16_384 });
    return stdout.trim() || undefined;
  } catch { return undefined; }
}
