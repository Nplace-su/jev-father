import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectRepo, parseRepo } from './lib/github.mjs';
import { judge } from './lib/judge.mjs';
import { demoResult } from './lib/demo.mjs';

try { process.loadEnvFile(fileURLToPath(new URL('.env', import.meta.url))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const port = Number(process.env.PORT || 3210);
let busy = false;
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
function send(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
const server = http.createServer(async (req, res) => {
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
    if (req.method === 'GET' && req.url === '/api/config') return send(res, 200, { configured: !!process.env.TYPESAFE_API_KEY, model: process.env.JEV_MODEL || 'jev-latest' });
    if (req.method === 'GET' && req.url === '/api/demo') return send(res, 200, demoResult());
    if (req.method !== 'POST' || req.url !== '/api/judge') return send(res, 404, { error: '没有这个页面。' });
    if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: '请发送 JSON。' });
    if (busy) return send(res, 429, { error: '上一位还没审完，稍等一下。' });
    let body = ''; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 2048) { send(res, 413, { error: '请求过长。' }); return; } body += chunk.toString(); }
    let input;
    try { input = JSON.parse(body); } catch { return send(res, 400, { error: 'JSON 格式不正确。' }); }
    parseRepo(input?.url);
    if (!process.env.TYPESAFE_API_KEY) return send(res, 503, { error: '还没配置 TYPESAFE_API_KEY。复制 .env.example 为 .env，填入密钥后重启服务。' });
    busy = true;
    try { const repo = await collectRepo(input.url); send(res, 200, await judge(repo)); }
    finally { busy = false; }
  } catch (e) {
    const message = e.name === 'TimeoutError' ? '远程服务超时，请稍后再试。' : e.message;
    send(res, 400, { error: message });
  }
});
server.requestTimeout = 150_000;
server.listen(port, '127.0.0.1', () => console.log(`Jev Judger → http://localhost:${port}`));
