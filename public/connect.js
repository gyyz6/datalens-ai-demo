const get = s => document.querySelector(s);
const escapeText = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let checking=false,accessBusy=false,connectionStatus=null;
const cloudMode=()=>connectionStatus?.deployment==='cloud';
const locked=()=>cloudMode() && connectionStatus.authRequired && !connectionStatus.authenticated;
function setAccessMessage(message,error=false) {
  get('#accessMessage').textContent=message;
  get('#accessMessage').className='form-message'+(error?' error':'');
}
function updateButtons() {
  get('#verify').disabled=checking || accessBusy || !connectionStatus?.configured || locked();
  get('#check').disabled=checking || accessBusy;
  get('#unlock').disabled=accessBusy;
  get('#logout').disabled=accessBusy;
}
function renderConnection(data) {
  connectionStatus=data;
  const cloud=cloudMode(),needsAccess=locked();
  get('#connectionLoading').hidden=true;
  get('#cloudAccess').hidden=!cloud;
  get('#localSetup').hidden=cloud;
  get('#heroTitle').textContent=cloud?'把经营问题，交给 AI 分析师。':'让分析师，连接真实模型。';
  get('#heroDetail').textContent=cloud?'连接 DeepSeek，从数据变化走向有证据的经营判断。':'DeepSeek 官方平台已预设。把 Key 保存在本机，模型负责理解与解释，指标交给工具计算。';
  if (cloud) {
    get('#accessForm').hidden=!needsAccess;
    get('#accessSuccess').hidden=needsAccess;
    get('#accessTitle').textContent=needsAccess?'解锁 AI 分析':'工作空间已就绪';
    get('#accessDetail').textContent=needsAccess?'输入工作空间访问码，开启 DeepSeek 问数与分析。':'真实模型负责理解问题，数据工具计算每一项指标。';
    get('#accessNote').hidden=!needsAccess;
    get('#logout').hidden=!data.authRequired;
    get('#status').className='status'+(data.configured && !needsAccess?' ready':'');
    get('#status').textContent=needsAccess?'AI 分析待解锁':data.configured?'模型已配置 · 可开始分析':'模型暂未就绪';
    get('#statusDetail').textContent=needsAccess?(data.configured?'模型已配置。解锁后即可验证连接或开始问数。':'解锁后可查看模型连接状态。'):data.configured?'配置已读取。实际调用成功后会在这里显示验证结果。':'请联系工作空间提供者完成模型配置，或先体验本地规则问数。';
    get('#endpoint').textContent='平台：DeepSeek 官方\n模型：'+(data.model || '待配置');
    get('#check').textContent='刷新连接状态';
  } else {
    get('#status').className='status'+(data.configured?' ready':'');
    get('#status').textContent=data.configured?'已读取 Key · 尚需真实调用验证':'尚未配置 API Key';
    get('#statusDetail').textContent=data.configured?'配置已读取。点击下方按钮可验证 Key、账户与完整工具调用流程。':'请把 Key 填入本机 .env 文件，保存后重新点击“检测配置”。';
    get('#endpoint').textContent='平台：DeepSeek 官方\n接口：https://api.deepseek.com\n模型：'+data.model;
    get('#check').textContent='检测配置';
  }
  updateButtons();
}
async function readBody(response) { return response.json().catch(()=>({})); }
function accessExpired(message) {
  renderConnection({...connectionStatus,deployment:'cloud',authRequired:true,authenticated:false});
  setAccessMessage(message || '访问状态已失效，请重新输入访问码。',true);
}
async function getSession(signal) {
  const response=await fetch('/api/session',{cache:'no-store',credentials:'same-origin',signal});
  const data=await readBody(response);
  if (!response.ok) throw Object.assign(new Error(data.message || '暂时无法连接模型服务，请稍后重试。'),{code:response.status===401?'ACCESS_REQUIRED':data.code});
  if (!data.session) throw new Error('连接状态不完整，请刷新后重试。');
  return data.session;
}
async function checkConfig() {
  try {
    if (location.protocol==='file:') throw new Error('STATIC_PREVIEW');
    const response=await fetch('/api/status',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(10000)});
    if (response.status===404) throw new Error('STATIC_PREVIEW');
    if (!response.ok) throw new Error();
    renderConnection(await response.json());
    return true;
  } catch(error) {
    const isStatic=error.message==='STATIC_PREVIEW';
    if (isStatic) {
      connectionStatus=null;
      get('#connectionLoading').hidden=true;get('#cloudAccess').hidden=true;get('#localSetup').hidden=false;
    }
    get('#status').className=isStatic?'status':'status fail';
    get('#status').textContent=isStatic?'静态演示 · 真实模型需启动后端':'暂时无法读取连接状态';
    get('#statusDetail').textContent=isStatic?'当前可直接体验看板和本地规则问数。使用真实模型时，下载项目并启动本地服务，再填写自己的 Key。':'请检查网络连接后重试。';
    if (isStatic) get('#endpoint').textContent='平台：DeepSeek 官方\n接口：https://api.deepseek.com\n模型：deepseek-flash（本地默认）';
    get('#verify').disabled=true;
    return false;
  }
}
get('#check').onclick=checkConfig;
get('#accessForm').onsubmit=async event=>{
  event.preventDefault();
  if (accessBusy) return;
  const field=get('#accessCode');
  let accessCode=field.value;
  if (!accessCode) return;
  accessBusy=true;updateButtons();setAccessMessage('正在解锁…');
  try {
    const response=await fetch('/api/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessCode}),signal:AbortSignal.timeout(15000)});
    const data=await readBody(response);
    if (!response.ok || !data.authenticated) throw new Error(data.message || '访问码未能通过验证，请重试。');
    try { sessionStorage.setItem('datalens-mode','live'); } catch {}
    const refreshed=await checkConfig();
    if (!refreshed) setAccessMessage('访问码已通过验证，请刷新连接状态后继续。');
    else if (locked()) setAccessMessage('登录状态未能保存，请允许本站使用 Cookie 后重试。',true);
    else setAccessMessage('已解锁，可以开始 AI 问数。');
  } catch(error) {
    setAccessMessage(error.name==='TimeoutError'?'请求超时，请稍后重试。':error instanceof TypeError?'暂时无法连接服务，请检查网络后重试。':error.message,true);
  } finally {
    accessCode='';field.value='';accessBusy=false;updateButtons();
  }
};
get('#logout').onclick=async()=>{
  if (accessBusy) return;
  accessBusy=true;updateButtons();setAccessMessage('正在退出…');
  try {
    const session=await getSession(AbortSignal.timeout(10000));
    const response=await fetch('/api/logout',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Datalens-Session':session},body:'{}',signal:AbortSignal.timeout(10000)});
    const data=await readBody(response);
    if (!response.ok) throw Object.assign(new Error(data.message || '暂时无法退出，请重试。'),{code:response.status===401?'ACCESS_REQUIRED':data.code});
    renderConnection({...connectionStatus,authenticated:false});
    get('#result').innerHTML='<p>解锁后可验证真实分析，或返回看板继续浏览。</p>';
    await checkConfig();setAccessMessage('已退出 AI 访问，看板仍可浏览。');
  } catch(error) {
    if (error.code==='ACCESS_REQUIRED') accessExpired();
    else setAccessMessage('暂时无法退出，请检查网络后重试。',true);
  } finally {accessBusy=false;updateButtons();}
};
get('#verify').onclick=async()=>{
  if (checking || locked()) return;
  checking=true;updateButtons();
  get('#status').className='status';get('#status').textContent='正在验证真实分析…';
  get('#statusDetail').textContent='正在检查模型响应、工具执行和最终答案。';
  get('#result').innerHTML='<p>正在请求真实模型、执行指标工具并核对返回结果…</p>';
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),100000);
  try {
    const session=await getSession(controller.signal);
    const response=await fetch('/api/analyze',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Datalens-Session':session},body:JSON.stringify({question:'当前周期 GMV 为什么下降？',scope:{days:7,channel:'all'}}),signal:controller.signal});
    const data=await readBody(response);
    if (data.code==='ACCESS_REQUIRED' || (response.status===401 && !data.code)) throw Object.assign(new Error(data.message),{code:'ACCESS_REQUIRED'});
    if (!response.ok || data.status!=='ok') {
      const reachedModel=data.trace?.some(t=>t.step==='请求模型选择工具'&&t.status==='ok');
      get('#status').className='status '+(reachedModel?'ready':'fail');
      get('#status').textContent=reachedModel?'API 已连通 · 分析未完成':'此次分析未完成';
      get('#statusDetail').textContent=reachedModel?'DeepSeek 已接受请求并返回内容；本次分析在后续步骤中停止。':cloudMode()?'本次没有生成可验证的分析结果，请根据下方提示处理。':'请根据下方错误原因处理，不必反复更换 Key。';
      get('#result').innerHTML='<h2>'+(reachedModel?'连接正常，分析需要重试':'分析状态')+'</h2><p>'+escapeText(data.message||'模型未给出可验证答案，请稍后重试。')+'</p>'+(data.trace?.length?'<ol class="trace">'+data.trace.map(t=>'<li>'+escapeText(t.step)+' · '+escapeText(t.status)+'</li>').join('')+'</ol>':'');
    } else {
      get('#status').className='status ready';get('#status').textContent='真实分析成功';
      get('#statusDetail').textContent='已完成模型选工具 → 后端计算 → 模型解释 → 证据返回。';
      get('#result').innerHTML='<h2>连接成功，可以开始分析</h2><p>'+escapeText(data.answer.summary)+'</p><p>工具计算 GMV：¥'+data.analysis.current.gmv.toLocaleString('zh-CN')+'<br>模型：'+escapeText(data.model)+' · 用时 '+(data.durationMs/1000).toFixed(1)+' 秒</p><ol class="trace">'+data.trace.map(t=>'<li>'+escapeText(t.step)+(t.tool?' · '+escapeText(t.tool):'')+' · '+escapeText(t.status)+'</li>').join('')+'</ol><a class="btn primary" href="index.html#agent">进入 AI 问数</a>';
    }
  } catch(error) {
    if (error.code==='ACCESS_REQUIRED') {
      accessExpired();get('#result').innerHTML='<p>请先输入工作空间访问码，再验证真实分析。</p>';
    } else {
      get('#status').className='status fail';get('#status').textContent='请求未完成';get('#statusDetail').textContent='未收到完整结果，暂时无法判断本次模型调用状态。';
      get('#result').innerHTML='<p>'+(cloudMode()?'请求中断或超时，请稍后重试。':'请求中断或超时，请确认本地服务与网络正常后重试。')+'</p>';
    }
  } finally {clearTimeout(timer);checking=false;updateButtons();}
};
checkConfig();

