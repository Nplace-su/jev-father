import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import net from 'node:net';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error('Node.js 20.12+ required. Install a supported LTS runtime, then run again.');
  process.exit(1);
}
const root = fileURLToPath(new URL('../', import.meta.url));
try { process.loadEnvFile(join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const first = Number(process.env.PORT || 3210);
if (!Number.isInteger(first) || first < 1 || first > 65535) {
  console.error('PORT must be an integer between 1 and 65535.'); process.exit(1);
}
async function isOurs(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800), redirect: 'error' });
    const data = await r.json();
    return r.ok && data.app === 'jev-judger' && data.status === 'ready';
  } catch { return false; }
}
async function isFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}
function report(status, port, extra = {}) {
  console.log(JSON.stringify({ status, url: `http://localhost:${port}`, ...extra }));
}
async function start() {
  for (let port = first; port <= Math.min(first + 10, 65535); port++) {
    if (await isOurs(port)) { report('already-running', port); return; }
    if (!await isFree(port)) continue;
    const stateDir = join(root, '.local');
    mkdirSync(stateDir, { recursive: true });
    const log = join(stateDir, `server-${port}.log`);
    const fd = openSync(log, 'a', 0o600);
    let child;
    try {
      child = spawn(process.execPath, [join(root, 'server.mjs')], {
        cwd: root, env: { ...process.env, PORT: String(port) },
        detached: true, stdio: ['ignore', fd, fd], windowsHide: true,
      });
    } finally { closeSync(fd); }
    let failed = false;
    child.on('error', () => { failed = true; });
    child.on('exit', () => { failed = true; });
    child.unref();
    for (let attempt = 0; attempt < 40; attempt++) {
      if (failed) break;
      if (await isOurs(port)) { report('started', port, { pid: child.pid, log }); return; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    // Do not leave a failed startup orphaned or kill any pre-existing process.
    if (!failed) child.kill();
    throw new Error(`Startup failed; inspect ${log}`);
  }
  throw new Error(`No available local port between ${first} and ${Math.min(first + 10, 65535)}`);
}
start().catch(error => { console.error(error.message); process.exitCode = 1; });
