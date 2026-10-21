/* Model requests go through the same-origin server. API keys never enter this page. */
const ruleAsk = ask, ruleShowAnswer = showAnswer, ruleAgentHTML = agentHTML;
let modelMode = 'rule', liveInFlight = false, modelStatus = null, hasModePreference = false;
try {
  const savedMode = sessionStorage.getItem('datalens-mode');
  if (['rule','live'].includes(savedMode)) { modelMode=savedMode; hasModePreference=true; }
} catch {}

function accessLocked() {
  return modelStatus?.deployment==='cloud' && modelStatus.authRequired && !modelStatus.authenticated;
}
function modelConnectionText() {
  if (!modelStatus) return '正在读取模型连接状态…';
  if (modelStatus.deployment==='cloud') {
    if (accessLocked()) return '输入访问码后即可使用真实模型分析。';
    return modelStatus.configured ? '模型已配置 · 发送问题开始真实分析' : '模型暂未就绪，请稍后再试。';
  }
  return modelStatus.configured ? '已读取 Key · 发送问题后验证真实调用' : '尚未配置 Key · 请在模型连接页完成设置';
}

agentHTML = function () {
  const live = modelMode === 'live';
  return ruleAgentHTML()
    .replace('流程演示', live ? 'DeepSeek · 真实模型' : '本地规则演示')
    .replace('把问题交给我，把判断留给你。', live ? '模型理解问题，工具计算指标，证据支持判断。' : '本地规则与模板回答，不调用大模型。')
    .replace('<div class="agent-body">', `<div class="agent-body"><div class="live-controls"><label>分析方式 <select id="modelMode" aria-label="分析方式"><option value="live" ${live?'selected':''}>DeepSeek 真实模型</option><option value="rule" ${live?'':'selected'}>本地规则演示</option></select></label><a href="connect.html">${accessLocked()?'解锁 AI 分析':'模型连接'} ↗</a></div>${live?`<div class="live-controls"><label>周期 <select id="livePeriod" aria-label="问数周期">${[7,14,30].map(n=>`<option value="${n}" ${state.days===n?'selected':''}>最近 ${n} 天</option>`).join('')}</select></label><label>渠道 <select id="liveChannel" aria-label="问数渠道">${['all',...new Set(rows.map(r=>r.channel))].map(c=>`<option value="${esc(c)}" ${state.channel===c?'selected':''}>${c==='all'?'全部渠道':esc(c)}</option>`).join('')}</select></label></div><p class="live-status">${modelConnectionText()}</p>${accessLocked()?'<div class="live-access"><div><strong>解锁 AI 分析</strong><p>使用工作空间访问码，开启 DeepSeek 问数与分析。</p></div><a class="btn soft small" href="connect.html">输入访问码 →</a></div>':''}`:''}`)
    .replace('本地规则模拟 AI · 指标由工具计算 · 支持有限问题类型', live ? '以顶部周期与渠道筛选为准 · 问题与聚合结果发送至 DeepSeek' : '本地规则模拟 AI · 不产生模型费用');
};
document.addEventListener('change', e => {
  if (['livePeriod','liveChannel'].includes(e.target.id)) {
    state[e.target.id==='livePeriod'?'days':'channel'] = e.target.id==='livePeriod'?Number(e.target.value):e.target.value;
    runId++; answerState=null; render(); return;
  }
  if (e.target.id !== 'modelMode') return;
  modelMode = e.target.value; hasModePreference=true; runId++; answerState = null;
  try { sessionStorage.setItem('datalens-mode', modelMode); } catch {}
  renderAgent();
});

ask = async function (q) {
  if (datasetBlocked()) { toast('请先恢复数据或重新上传。'); return; }
  if (modelMode === 'rule') return ruleAsk(q);
  if (liveInFlight) { toast('上一条模型请求仍在处理，请稍后再试'); return; }
  if (!q.trim() || q.length > 200) return;
  const id = ++runId;
  if (accessLocked()) {
    answerState={q,live:true,code:'ACCESS_REQUIRED',error:'请先使用工作空间访问码解锁 AI 分析。'};
    renderAgent(); return;
  }
  if (activeDataset && !activeDataset.id) {
    answerState={q,live:true,error:'当前文件仅载入浏览器。请启动服务并重新导入，以使用真实 AI 分析。'};
    renderAgent(); return;
  }
  liveInFlight = true;
  answerState = {q,live:true,busy:true}; renderAgent();
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 100000);
  try {
    const sessionRes = await fetch('/api/session', {cache:'no-store',credentials:'same-origin',signal:abort.signal});
    if (!sessionRes.ok) {
      const errorData=await sessionRes.json().catch(()=>({}));
      const accessRequired=sessionRes.status===401 || errorData.code==='ACCESS_REQUIRED';
      if (accessRequired) modelStatus={...modelStatus,deployment:'cloud',authRequired:true,authenticated:false};
      throw Object.assign(new Error(errorData.message || '模型服务暂时不可用，请稍后重试。'),{code:accessRequired?'ACCESS_REQUIRED':errorData.code});
    }
    const session = await sessionRes.json();
    const res = await fetch('/api/analyze', {
      method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Datalens-Session':session.session},
      body:JSON.stringify({question:q,scope:{...state},...(activeDataset?.id?{datasetId:activeDataset.id}:{})}),signal:abort.signal
    });
    const data = await res.json();
    if (id !== runId) return;
    if (!res.ok || data.status !== 'ok') {
      if (data.code==='ACCESS_REQUIRED' || (res.status===401 && !data.code)) {
        data.code='ACCESS_REQUIRED';
        modelStatus={...modelStatus,deployment:'cloud',authRequired:true,authenticated:false};
      }
      if (['DATASET_NOT_FOUND','DATASET_EXPIRED'].includes(data.code)) { datasetUnavailable=true; rows=[]; render(); }
      answerState = {q,live:true,error:data.message || '模型未返回可验证的答案，请稍后重试。',trace:data.trace,code:data.code};
    } else {
      state = {...data.scope};
      answerState = {q,live:true,...data,source:source,dataset:data.dataset||activeDataset};
      modelStatus = {...modelStatus,configured:true};
      render();
    }
  } catch (err) {
    if (id === runId) answerState = {q,live:true,code:err.code,error:err.name==='AbortError'?'请求超时。此次未展示分析结果，请稍后重试。':err.code==='ACCESS_REQUIRED'?'访问状态已失效，请重新输入访问码。':modelStatus?.deployment==='cloud'?'暂时无法连接模型服务，请稍后再试。':'无法完成请求。请确认本地服务正在运行；模型连接页可检查配置。'};
  } finally {
    clearTimeout(timer); liveInFlight = false;
    if (id === runId) renderAgent();
  }
};

function liveTrace(trace) {
  return (trace || []).map(t => `<li>${esc(t.step)}${t.tool?` · <code>${esc(t.tool)}(${esc(JSON.stringify(t.args||{}))})</code>`:''} · ${esc(t.status)}${Number.isFinite(t.durationMs)?` · ${(t.durationMs/1000).toFixed(2)} 秒`:''}</li>`).join('');
}
function fullMetricLines(a,comparisonComplete=true) {
  return [['gmv','GMV',money2],['orders','支付订单',num],['sessions','访问次数',num],['cvr','订单转化率',pct],['aov','客单价',money2],['spend','广告消耗',money2],['roas','投放 ROAS',v=>v==null?'—':v.toFixed(2)+'×']].map(([key,label,format])=>`${label}：${comparisonComplete?'本期':'本期已记录'} ${format(a.current[key])}${comparisonComplete&&a.previous&&a.delta?` / 上期 ${format(a.previous[key])} / 环比 ${change(a.delta[key])}`:' / 对比覆盖不足，暂不比较'}`);
}
showAnswer = function () {
  const s=answerState,r=$('#agentResult');if(!s||!r)return;
  if(!s.live)return ruleShowAnswer();
  if(s.busy){
    r.innerHTML=`<div class="question-box">${esc(s.q)}</div><div class="trace live-busy"><summary>正在请求 DeepSeek 并执行数据工具…</summary><p class="sub" style="margin-top:10px">正在理解问题、计算指标与组织证据。结果就绪后自动显示。</p><div class="live-stage" aria-hidden="true"><i></i><i></i><i></i><i></i></div></div>`;return;
  }
  if(s.error){
    r.innerHTML=`<div class="question-box">${esc(s.q)}</div><div class="answer"><p class="lead">${s.code==='ACCESS_REQUIRED'?'解锁 AI 分析':s.code==='CONFIG_MISSING'?'模型暂未就绪':'这次未生成分析结果'}</p><p>${esc(s.error)}</p><div class="agent-actions">${datasetUnavailable?'<button class="btn soft small" data-nav="data">管理数据</button>':`<a class="btn soft small" href="connect.html">${s.code==='ACCESS_REQUIRED'?'输入访问码':'检查模型连接'}</a>`}</div>${s.trace?.length?`<details class="trace" style="margin-top:14px"><summary>查看本次执行记录</summary><ol>${liveTrace(s.trace)}</ol></details>`:''}</div>`;return;
  }
  const a=s.analysis,result=s.answer,complete=readyComparison(a),label=s.dataset?.name||s.source||'固定模拟数据';
  const facts=fullMetricLines(a,complete);
  r.innerHTML=`<div class="question-box">${esc(s.q)}</div>
    <details class="trace"><summary><span>✓ 真实模型与工具调用已完成</span><span>${(s.durationMs/1000).toFixed(1)} 秒 ⌄</span></summary><ol>${liveTrace(s.trace)}</ol><p class="sub">${esc(s.model)} · 输入 ${s.usage?.inputTokens||0} / 输出 ${s.usage?.outputTokens||0} tokens</p></details>
    <div class="answer"><p class="lead">${esc(result.summary)}</p><p class="sub">${esc(label)}<br>范围：${esc(a.range.start)} — ${esc(a.range.end)} · ${esc(s.scope.channel==='all'?'全部渠道':s.scope.channel)}</p>
    ${complete?'':'<div class="partial-badge">当前或对比周期不完整 · 仅分析已记录数据，不输出环比</div>'}
    <h3 style="margin-top:14px">工具计算的事实</h3><ul><li>${complete?'本期':'本期已记录'} GMV <strong>${money(a.current.gmv)}</strong>${complete?`，较上期 <strong>${change(a.delta?.gmv)}</strong>`:''}。</li><li>支付订单 ${num(a.current.orders)}；访问 ${num(a.current.sessions)} 次。</li><li>订单转化率 ${pct(a.current.cvr)}${complete?`（${pp(a.current.cvr,a.previous?.cvr)}）`:''}；客单价 ${money2(a.current.aov)}。</li><li>广告消耗 ${money2(a.current.spend)}${complete?`（环比 ${change(a.delta?.spend)}）`:''}；投放 ROAS ${a.current.roas==null?'—':a.current.roas.toFixed(2)+'×'}${complete?`（环比 ${change(a.delta?.roas)}）`:''}。</li></ul>
    <div class="answer-callout"><strong>模型提出的待验证解释</strong><ul>${result.hypotheses.map(h=>`<li>${esc(h)}</li>`).join('')||'<li>当前证据不足以判断业务原因。</li>'}</ul></div>
    <h3>建议下一步</h3><ul>${result.actions.map(h=>`<li>${esc(h)}</li>`).join('')||'<li>补充业务信息后继续验证。</li>'}</ul></div>
    <details class="evidence"><summary>查看工具证据与渠道明细 · ${s.evidence.length} 份</summary><div class="evidence-content"><b>数据源：</b>${esc(label)} · ${s.dataset?.kind==='uploaded'?'自定义数据':'固定模拟数据'}<br>${complete?`<b>上期：</b>${esc(a.previousRange.start)} — ${esc(a.previousRange.end)}<br>`:'<b>完整性：</b>覆盖不足，前期与变化率不参与解释。<br>'}<b>引用：</b>${result.evidenceIds.map(esc).join('、')}<br>${s.evidence.map(e=>`${esc(e.id)} · ${esc(e.tool)} · ${esc(JSON.stringify(e.scope))}`).join('<br>')}<hr><b>全部指标明细</b><br>${facts.map(esc).join('<br>')}<hr>${a.channels.map(c=>`<b>${esc(c.channel)}</b><br>${fullMetricLines(c,complete).map(esc).join('<br>')}`).join('<hr>')}<br>GMV 未扣退款；订单转化率=订单/访问；ROAS 仅汇总有投放费用的记录。相关变化不等于因果。</div></details>
    <div class="agent-actions"><button class="btn soft small" id="makeTask">${icon('check')}创建验证待办</button><button class="btn small" id="exportAnswer">${icon('download')}导出分析</button></div>`;
  $('#makeTask').onclick=()=>openAction((result.actions[0]||'核查本周期经营变化').slice(0,100),s);
  $('#exportAnswer').onclick=()=>download(`数见-AI分析-${a.range.end}.md`,`# 数见 · DeepSeek 分析记录\n\n问题：${s.q}\n模型：${s.model}\n数据：${label}\n范围：${a.range.start} — ${a.range.end} / ${s.scope.channel}\n完整性：${complete?'覆盖完整':'部分记录，前期和变化率不参与分析'}\n\n## 模型摘要\n${result.summary}\n\n## 工具事实\n${facts.map(x=>'- '+x).join('\n')}\n\n${a.channels.map(c=>`### ${c.channel}\n${fullMetricLines(c,complete).map(x=>'- '+x).join('\n')}`).join('\n\n')}\n\n## 待验证解释\n${result.hypotheses.map(x=>'- '+x).join('\n')}\n\n## 建议行动（待人工确认）\n${result.actions.map(x=>'- '+x).join('\n')}\n\n## 真实执行记录\n${s.trace.map(t=>JSON.stringify(t)).join('\n')}\n\n引用：${result.evidenceIds.join('、')}\n用量：${JSON.stringify(s.usage)}；耗时：${s.durationMs}ms\n\n分析仅基于所选数据范围；相关性不等于因果。\n`);
  hydrate();
};

function applyModelAvailability(status) {
  modelStatus=status || {configured:false,available:false};
  if (!hasModePreference && !answerState && !liveInFlight) modelMode=modelStatus.configured?'live':'rule';
  if (!answerState) renderAgent();
}
if (location.protocol==='file:') applyModelAvailability(null);
else {
  renderAgent();
  fetch('/api/status',{cache:'no-store',signal:AbortSignal.timeout(3000)})
    .then(r=>r.ok?r.json():null).then(applyModelAvailability).catch(()=>applyModelAvailability(null));
}
