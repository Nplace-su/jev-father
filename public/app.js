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

async function judgeStream(url) {
  const response = await fetch('/api/judge', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ url }) });
  if (!response.ok) throw new Error((await response.json()).error || '请求失败。');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let result;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'error') throw new Error(event.error);
        if (event.type === 'progress') status(event.message, 'loading');
        if (event.type === 'result') result = event.result;
      }
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (!result) throw new Error('连接中断，本次评价未完成，请重试。');
  return result;
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
      <div class="verdict"><div class="stamp ${result.label.length > 2 ? 'long' : ''}">${esc(result.label)}</div><div class="verdict-copy"><small>THE JEV VERDICT / ${result.demo ? '示例判决' : 'JEV 终审'}</small><h2>${esc(result.line)}</h2><p>最终档位由 Jev Choice 选择 · 模型置信度 ${pct(result.confidence)}${result.demo ? '' : ` · ${result.batchCount} 批材料 · ${result.calls} 次调用 · ${(result.inferenceMs / 1000).toFixed(1)}s`}</p>${result.uncertain ? '<p class="warn">摇摆判决：Jev 自己也没太大把握。</p>' : ''}</div></div>
      <div class="distribution">${Object.entries(result.probabilities).map(([name, value]) => `<div class="prob"><div><span>${esc(name)}</span><span>${pct(value)}</span></div><div class="prob-track"><div class="prob-fill" style="width:${Math.max(0, Math.min(100, value * 100))}%"></div></div></div>`).join('')}</div>
      <div class="dimensions">${result.dimensions.map(d => `<article class="dimension"><h3>${esc(d.name)}</h3><div><strong>${esc(d.roast || d.reason)}</strong>${d.roast ? `<p>${esc(d.reason)}</p>` : ''}${d.uncertain ? '<p class="warn">暂定倾向，模型判断有不确定性；已保留给终审参考。</p>' : ''}</div><span class="confidence" title="分项模型置信度">${d.skip ? '免考' : pct(d.confidence)}</span></article>`).join('')}</div>
    </div>
    <p class="limitations">这是静态文本审阅的娱乐评价，未执行项目或核查外部实验；概率和置信度是模型输出，不是结论正确率。短评来自预写文案。${result.demo ? '此处全部数据均为虚构示例。' : ''}</p>
    ${!result.demo && result.usage ? `<p class="limitations">本次全部调用合计：${Number(result.usage.input_tokens).toLocaleString()} input tokens · ${Number(result.usage.output_tokens).toLocaleString()} output tokens。按 <a href="https://docs.typesafe.ai/models" target="_blank" rel="noreferrer">2026-09-23 Jev 1.13 单价</a>估算 $${(result.usage.input_tokens * 0.042 / 1e6).toFixed(5)}（输出免费；实际扣费以账户为准）。</p>` : ''}
    ${result.preparation ? `<details class="evidence"><summary>送审清单 · ${result.preparation.originalChars.toLocaleString()} → ${result.preparation.submittedChars.toLocaleString()} 字符</summary><p>项目源码和文档全文送审；长 JSONL 由全部记录生成统计；重复内容只评一次。按目录识别的外部资料保留在原文件中，不参与项目贡献评分。</p><pre>${esc(result.preparation.manifest.map(f => `${f.path}：${({ full_text: '全文送审', all_rows_statistics: '全行统计送审', background: '外部背景，仅存档', duplicate: '内容重复，复用' })[f.treatment]}${f.duplicateOf ? ` ${f.duplicateOf}` : ''}`).join('\n'))}</pre></details>` : ''}
    <details class="evidence"><summary>呈堂材料 · 已读 ${repo.files.length} / ${repo.eligibleFiles ?? repo.files.length} 个范围内文件 · 仓库共 ${repo.totalFiles} 个</summary><p>${esc(repo.description)}<br>固定版本：${esc(repo.sha)}${repo.treeTruncated ? '<br>GitHub 目录被截断，读取范围不完整。' : ''}${repo.failedFiles.length ? `<br>读取失败：${esc(repo.failedFiles.join('、'))}` : ''}</p>${repo.excludedFiles?.length ? `<details><summary>排除 ${repo.excludedFiles.length} 项，查看原因</summary><pre>${esc(repo.excludedFiles.map(f => `${f.path}：${f.reason}`).join('\n'))}</pre></details>` : ''}${repo.files.map((f, i) => `<details class="file" data-file="${i}"><summary>${esc(f.path)} ${f.excerpted ? '· 节选' : '· 全文'}</summary>${f.url ? `<p><a href="${esc(f.url)}" target="_blank" rel="noreferrer">查看此 commit 的原文件 ↗</a></p>` : ''}<pre></pre></details>`).join('')}</details>
    <details class="evidence" id="engine"><summary>打开引擎盖 · 分批审阅 / 跨文件汇总 / 五档终审</summary><p>所有判断均为 Jev Choice。${result.batchCount ?? 1} 批材料，${result.mergeCalls ?? 0} 次汇总，1 次终审；没有加权分数定档。</p><pre></pre></details>
    <div class="result-actions"><button id="copy">复制判决</button><button id="download">下载 JSON</button></div>`;
  $('#result').hidden = false;
  document.querySelectorAll('[data-file]').forEach(details => details.addEventListener('toggle', () => {
    if (details.open) details.querySelector('pre').textContent = repo.files[Number(details.dataset.file)].content;
  }));
  $('#engine').addEventListener('toggle', () => {
    if ($('#engine').open) $('#engine pre').textContent = JSON.stringify({ preparation: result.preparation, evidence: result.evidence, usage: result.usage, stages: result.stages, payloads: result.payloads, responses: result.raw }, null, 2);
  });
  $('#copy').addEventListener('click', async () => {
    const text = `${result.demo ? '【虚构示例，非真实评价】\n' : ''}${repo.fullName}：${result.label}\n${result.line}\n${result.dimensions.map(d => `${d.name}：${d.roast || d.reason}`).join('\n')}\nJev Judger · 静态文本审阅，仅供娱乐${repo.url ? `\n${repo.url}\ncommit: ${repo.sha}` : ''}`;
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
  setBusy(true); status('正在读取仓库全文；读取与分批审阅进度会实时显示。', 'loading');
  try { render(await judgeStream(url)); status(''); }
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
