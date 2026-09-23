import { fork, spawn } from 'node:child_process';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error('需要 Node.js 20.12 或更新版本。请从 https://nodejs.org 下载并安装 LTS 版本。');
  process.exit(1);
}
const child = fork(new URL('../server.mjs', import.meta.url), [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
child.once('message', message => {
  if (message?.type !== 'ready' || process.env.JEV_NO_OPEN === '1') return;
  const [command, args] = process.platform === 'darwin' ? ['open', [message.url]]
    : process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', message.url]] : ['xdg-open', [message.url]];
  const opener = spawn(command, args, { stdio: 'ignore' });
  opener.on('error', () => console.log('浏览器未能自动打开，请手动访问上面的本机网址。'));
  opener.on('exit', code => { if (code) console.log('请手动在浏览器打开上面的本机网址。'); });
});
child.on('error', () => { console.error('无法启动本地服务，请检查 Node.js 安装。'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
