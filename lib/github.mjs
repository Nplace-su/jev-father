import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TEXT_EXT = /\.(md|mdx|rst|txt|py|pyi|ipynb|js|jsx|ts|tsx|mjs|cjs|vue|svelte|html|css|scss|json|jsonl|csv|tsv|toml|ya?ml|ini|cfg|xml|urdf|xacro|sdf|proto|rs|go|cpp|hpp|cc|cxx|c|h|sh|bash|zsh|rb|java|kt|swift|cs|cmake|launch|msg|srv|action)$/i;
const TEXT_NAME = /(^|\/)(readme|dockerfile(?:\.[\w-]+)?|makefile|cmakelists\.txt|license|notice|\.gitignore|\.dockerignore)$/i;
const EXCLUDE = /(^|\/)(node_modules|vendor|dist|build|\.git|\.venv|venv|__pycache__|\.next|coverage|site-packages)(\/|$)|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|.*\.lock|\.env(?:\..*)?)$|\.min\.(js|css)$|\.map$/i;
export const LIMITS = { fileBytes: 1_000_000, totalBytes: 4_000_000, files: 1000 };

async function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 5000, maxBuffer: 16_384 });
    return stdout.trim() || undefined;
  } catch { return undefined; }
}
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

// Bounded concurrency, stable ordering, and no new work after a failure.
export async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length); let next = 0; let failure;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && !failure) {
      const i = next++;
      try { results[i] = await fn(items[i], i); } catch (error) { failure ||= error; }
    }
  }));
  if (failure) throw failure;
  return results;
}
export function exclusionReason(file) {
  if (file.type === 'commit') return '外部子模块';
  if (file.mode === '120000') return '符号链接';
  if (EXCLUDE.test(file.path)) return '依赖、构建产物、锁文件或环境配置';
  if (!TEXT_EXT.test(file.path) && !TEXT_NAME.test(file.path)) return '非支持的源码、文档或配置类型';
  if (file.size > LIMITS.fileBytes) return '单文件超过 1 MB';
  return null;
}
export function selectFiles(tree) {
  const priority = file => /(^|\/)readme(?:\.|$)/i.test(file.path) ? 100 - file.path.split('/').length : 0;
  return tree.filter(f => f.type === 'blob' && !exclusionReason(f))
    .sort((a, b) => priority(b) - priority(a) || a.path.localeCompare(b.path));
}
export async function collectRepo(input, { fetchImpl = fetch, token = process.env.GITHUB_TOKEN, onProgress = () => {} } = {}) {
  const { fullName } = parseRepo(input);
  token ||= await githubToken();
  onProgress('正在读取仓库目录并固定 commit…');
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'jev-father/0.2', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
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
  if (listing.truncated) throw new Error('GitHub 返回的目录不完整，当前仓库过大，未发起评价。');
  const selected = selectFiles(listing.tree);
  if (selected.length > LIMITS.files || selected.reduce((sum, f) => sum + (f.size ?? 0), 0) > LIMITS.totalBytes) {
    throw new Error('相关文本超过当前单次范围（1000 文件 / 4 MB），未抽样或发起评价。');
  }
  let completed = 0; let bytes = 0;
  const settled = await mapConcurrent(selected, 6, async f => {
    const path = f.path.split('/').map(encodeURIComponent).join('/');
    try {
      const response = await fetchImpl(`https://raw.githubusercontent.com/${fullName}/${commit.sha}/${path}`, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const content = await limitedText(response, LIMITS.fileBytes);
      if (content.includes('\0')) throw new Error('二进制内容');
      bytes += Buffer.byteLength(content);
      return { file: { path: f.path, url: `https://github.com/${fullName}/blob/${commit.sha}/${path}`, content, totalLines: content.split('\n').length, excerpted: false } };
    } catch (error) { return { failure: { path: f.path, reason: error.message } }; }
    finally { onProgress(`正在读取完整文件 ${++completed} / ${selected.length}`); }
  });
  if (bytes > LIMITS.totalBytes) throw new Error('实际文本超过 4 MB，未发起评价。');
  const files = settled.flatMap(r => r.file ? [r.file] : []);
  if (!files.length) throw new Error('没有读到可评价的文本或代码文件。');
  const failures = settled.flatMap(r => r.failure ? [r.failure] : []);
  return { fullName, url: `https://github.com/${fullName}`, sha: commit.sha,
    description: metadata.description ?? '', files, treeTruncated: false,
    totalFiles: listing.tree.filter(f => f.type === 'blob' || f.type === 'commit').length,
    eligibleFiles: selected.length, failedFiles: failures.map(f => f.path), failures,
    excludedFiles: listing.tree.filter(f => f.type === 'blob' || f.type === 'commit').flatMap(f => exclusionReason(f) ? [{ path: f.path, reason: exclusionReason(f) }] : []),
    bytes, sampledAt: new Date().toISOString(),
  };
}
