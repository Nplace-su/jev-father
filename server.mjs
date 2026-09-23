import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { collectRepo, parseRepo } from './lib/github.mjs';
import { judge } from './lib/judge.mjs';
import { demoResult } from './lib/demo.mjs';

export function createApp({ configuredKey = '', model = 'jev-latest', collect = collectRepo, evaluate = judge } = {}) {
let busy = false;
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
function send(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
const server = http.createServer(async (req, res) => {
  const port = server.address().port;
  let streaming = false;
  const event = body => { if (!res.destroyed) res.write(JSON.stringify(body) + '\n'); };
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  // Local tool: don't let another website spend the user's API key.
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return send(res, 403, { error: '仅支持本机访问。' });
  if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return send(res, 403, { error: '来源不允许。' });
  try {
    if (req.method === 'GET' && files[req.url]) {
      const [file, type] = files[req.url];
      const content = await readFile(new URL(`public/${file}`, import.meta.url));
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(content);
    }
    if (req.method === 'GET' && req.url === '/api/health') return send(res, 200, { app: 'jev-father', status: 'ready' });
    if (req.method === 'GET' && req.url === '/api/config') return send(res, 200, { configured: !!configuredKey, model });
    if (req.method === 'GET' && req.url === '/api/demo') return send(res, 200, demoResult());
    if (req.method !== 'POST' || req.url !== '/api/judge') return send(res, 404, { error: '没有这个页面。' });
    if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: '请发送 JSON。' });
    if (busy) return send(res, 429, { error: '上一位还没审完，稍等一下。' });
    let body = ''; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 2048) { send(res, 413, { error: '请求过长。' }); return; } body += chunk.toString(); }
    let input;
    try { input = JSON.parse(body); body = ''; } catch { return send(res, 400, { error: 'JSON 格式不正确。' }); }
    parseRepo(input?.url);
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 1024 || /[^\x20-\x7e]/.test(input.apiKey))) return send(res, 400, { error: 'API key 格式无效。' });
    let key = input.apiKey?.trim() || configuredKey;
    delete input.apiKey;
    if (!key) return send(res, 400, { error: '请在页面填写你的 Jev API key；仅用于本次评审，不会保存。' });
    busy = true;
    try {
      streaming = req.headers.accept === 'application/x-ndjson';
      if (streaming) res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
      const onProgress = message => { if (streaming) event({ type: 'progress', message }); };
      const repo = await collect(input.url, { onProgress });
      const result = await evaluate(repo, { key, model, onProgress });
      if (streaming) { event({ type: 'result', result }); res.end(); }
      else send(res, 200, result);
    }
    finally { key = ''; busy = false; }
  } catch (e) {
    const message = e.name === 'TimeoutError' ? '远程服务超时，请稍后再试。' : e.message;
    if (streaming) { event({ type: 'error', error: message }); res.end(); }
    else send(res, 400, { error: message });
  }
});
server.requestTimeout = 150_000;
return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(fileURLToPath(new URL('.env', import.meta.url))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const port = Number(process.env.PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('PORT 必须是 1–65535 的整数。'); process.exit(1); }
  const server = createApp({ configuredKey: process.env.TYPESAFE_API_KEY, model: process.env.JEV_MODEL || 'jev-latest' });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用。已有服务可直接打开 http://localhost:${port}；或在 .env 设置其他 PORT。` : `本地服务启动失败（${error.code || 'unknown'}）。`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log(`Jev Father → ${url}\n仅本机访问。页面填写 Key 即可使用；按 Ctrl+C 停止。`);
    process.send?.({ type: 'ready', url });
  });
}
