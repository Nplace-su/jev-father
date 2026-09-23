const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = value => `${Math.round(value * 100)}%`;
let current;

async function request(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '请求失败，请重试。');
  return body;
}
function status(message, type = '') {
  $('#status').hidden = !message;
  $('#status').className = type;
  $('#status').textContent = message;
}
function setBusy(busy) {
  $('#submit').disabled = busy;
  $('#demo').disabled = busy;
  $('#repo-url').disabled = busy;
  $('#submit').textContent = busy ? '审理中…' : '即刻开庭 ↗';
}
function render(result) {
  current = result;
  const repo = result.repo;
  const repoLabel = repo.url ? `<a href="${esc(repo.url)}" target="_blank" rel="noreferrer">${esc(repo.fullName)} ↗</a>` : esc(repo.fullName);
  $('#result').innerHTML = `
    <div class="result-shell" style="--verdict:${esc(result.color)}">
      <div class="result-top"><b>${repoLabel}</b><span class="${result.demo ? 'demo-label' : ''}">${result.demo ? '虚构示例 · 预设结果 · 未调用 Jev' : `COMMIT ${esc(repo.sha.slice(0, 7))} · ${repo.files.length} 个文件`}</span></div>
      <div class="verdict"><div class="stamp ${result.label.length > 2 ? 'long' : ''}">${esc(result.label)}</div><div class="verdict-copy"><small>THE JEV VERDICT / ${result.demo ? '示例判决' : 'JEV 终审'}</small><h2>${esc(result.line)}</h2><p>最终档位由 Jev Choice 选择 · 模型置信度 ${pct(result.confidence)}${result.demo ? '' : ` · 两次推理 ${(result.inferenceMs / 1000).toFixed(1)}s`}</p>${result.uncertain ? '<p class="warn">摇摆判决：Jev 自己也没太大把握。</p>' : ''}</div></div>
      <div class="distribution">${Object.entries(result.probabilities).map(([name, value]) => `<div class="prob"><div><span>${esc(name)}</span><span>${pct(value)}</span></div><div class="prob-track"><div class="prob-fill" style="width:${Math.max(0, Math.min(100, value * 100))}%"></div></div></div>`).join('')}</div>
      <div class="dimensions">${result.dimensions.map(d => `<article class="dimension"><h3>${esc(d.name)}</h3><div><strong>${esc(d.roast || d.reason)}</strong>${d.roast ? `<p>${esc(d.reason)}</p>` : ''}</div><span class="confidence" title="分项模型置信度">${d.skip ? '免考' : pct(d.confidence)}</span></article>`).join('')}</div>
    </div>
    <p class="limitations">这是静态抽样的娱乐评价，未执行项目或核查外部实验；概率和置信度是模型输出，不是结论正确率。短评来自预写文案。${result.demo ? '此处全部数据均为虚构示例。' : ''}</p>
    <details class="evidence"><summary>呈堂材料 · ${repo.files.length} / ${repo.totalFiles} 个文件 · 查看实际送审片段</summary><p>${esc(repo.description)}<br>固定版本：${esc(repo.sha)}${repo.treeTruncated ? '<br>GitHub 目录被截断，抽样范围不完整。' : ''}${repo.failedFiles.length ? `<br>读取失败：${esc(repo.failedFiles.join('、'))}` : ''}</p>${repo.files.map(f => `<details class="file"><summary>${esc(f.path)} ${f.excerpted ? '· 节选' : '· 全文'}</summary>${f.url ? `<p><a href="${esc(f.url)}" target="_blank" rel="noreferrer">查看此 commit 的原文件 ↗</a></p>` : ''}<pre>${esc(f.content)}</pre></details>`).join('')}</details>
    <details class="evidence"><summary>打开引擎盖 · 两轮 state / questions / answers</summary><p>第一轮拆问题，第二轮选档位。中间没有聊天模型，也没有加权分数决定档位。</p><pre>${esc(JSON.stringify({ payloads: result.payloads, responses: result.raw }, null, 2))}</pre></details>
    <div class="result-actions"><button id="copy">复制判决</button><button id="download">下载 JSON</button></div>`;
  $('#result').hidden = false;
  $('#copy').addEventListener('click', async () => {
    const text = `${result.demo ? '【虚构示例，非真实评价】\n' : ''}${repo.fullName}：${result.label}\n${result.line}\n${result.dimensions.map(d => `${d.name}：${d.roast || d.reason}`).join('\n')}\nJev Judger · 静态抽样，仅供娱乐${repo.url ? `\n${repo.url}\ncommit: ${repo.sha}` : ''}`;
    try { await navigator.clipboard.writeText(text); $('#copy').textContent = '已复制 ✓'; } catch { status('剪贴板不可用，请下载 JSON。', 'error'); }
  });
  $('#download').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `jev-judgment-${repo.sha.slice(0, 7)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('#judge-form').addEventListener('submit', async event => {
  event.preventDefault();
  const url = $('#repo-url').value.trim();
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(url)) return status('请填写 GitHub 仓库首页链接，例如 https://github.com/作者/项目。', 'error');
  $('#result').hidden = true;
  setBusy(true); status('正在抽取仓库材料，再交给 Jev 分项判断与终审。通常需要几十秒。', 'loading');
  try { render(await request('/api/judge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })); status(''); }
  catch (e) { status(e.message, 'error'); }
  finally { setBusy(false); }
});
$('#demo').addEventListener('click', async () => {
  setBusy(true); status('');
  try { render(await request('/api/demo')); } catch (e) { status(e.message, 'error'); } finally { setBusy(false); }
});
request('/api/config').then(config => {
  if (!config.configured) { $('#config').hidden = false; $('#config').textContent = '法官还没领到钥匙：在 .env 配置 TYPESAFE_API_KEY 后重启。现在可以先看虚构示例。'; }
}).catch(() => status('连接不到本地服务，请确认 npm start 正在运行。', 'error'));
