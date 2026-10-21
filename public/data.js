/* Dataset handles stay in this tab. Raw imported rows are never persisted in browser storage. */
let activeDataset=null,datasetUnavailable=false,datasetRestoring=false,importBusy=false,importDraft=null,importFile=null,importEpoch=0;
const DATASET_KEY='datalens-dataset-v2';
const fieldLabels={date:'日期',channel:'渠道',sessions:'访问次数',orders:'支付订单',gmv:'成交金额',spend:'广告消耗'};
const originalRender=render,originalRenderData=renderData,originalRuleAsk=ask,originalExportReport=exportReport;
function rememberDataset(){try{if(activeDataset?.id)sessionStorage.setItem(DATASET_KEY,activeDataset.id);else sessionStorage.removeItem(DATASET_KEY);}catch{}}
function datasetName(){return activeDataset?.name||source;}
function datasetBlocked(){return datasetUnavailable||datasetRestoring;}
function syncSourceUI(){
  const uploaded=!!activeDataset;
  $('#sourceBadge').innerHTML=`<span class="dot"></span>${datasetRestoring?'恢复数据中':datasetUnavailable?'数据待恢复':uploaded?'自定义数据':'模拟数据'}`;
  $('#workspaceName').textContent=uploaded?'自定义分析空间':'栖物生活 · 演示店铺';
  const profileWorkspace=document.querySelector('.profile small');if(profileWorkspace)profileWorkspace.textContent=uploaded?'自定义数据 · 分析工作空间':'栖物生活 · 演示工作空间';
  $('#footerSource').textContent=datasetUnavailable?'数据不可用 · 请恢复或重新上传':uploaded?`${activeDataset.format?.toUpperCase()||'CSV'} 数据 · 当前会话`:'模拟数据 · 演示工作空间';
}
render=function(){
  if(datasetBlocked()){
    syncSourceUI();
    $('#periodText').textContent='';$('#sourceLabel').textContent=datasetRestoring?'正在恢复自定义数据':'自定义数据不可用';
    $('#qualityBanner').innerHTML=`<div class="quality warning">${datasetRestoring?'正在恢复当前会话的数据，请稍候。':'自定义数据已过期、服务重启或访问状态失效。请重新上传，或明确选择恢复模拟数据。'}</div>`;
    $('#metrics').innerHTML='<div class="card empty dataset-empty">'+icon('database')+'<h2>等待数据就绪</h2><p>数据恢复后，指标与分析会在这里呈现。</p><button class="btn soft" data-nav="data">管理数据 →</button></div>';
    $('#trendChart').innerHTML='<div class="empty">当前没有可分析的数据。</div>';$('#channelsTable').innerHTML='';$('#chartInsight').innerHTML='';
    renderData();renderTasks();renderAgent();hydrate();return;
  }
  originalRender();syncSourceUI();
};
renderData=function(){
  if(datasetBlocked()){
    $('#dataQuality').innerHTML=`<div class="quality warning">${datasetRestoring?'正在恢复当前会话的数据…':'上传数据暂不可用。请重新上传或恢复模拟数据，系统不会自动替换数据源。'}</div>`;
    $('#datasetInfo').innerHTML='<b>自定义数据待恢复</b><br>数据内容不保存在浏览器存储中。';return;
  }
  originalRenderData();
  if(activeDataset)$('#datasetInfo').innerHTML+=`<br><span class="data-lifecycle">${activeDataset.id?'会话内临时保存 · 支持真实 AI 分析':'仅浏览器内存 · 本地规则分析'}</span>`;
};
ask=function(q){if(datasetBlocked()){toast('请先恢复数据或重新上传。');return;}return originalRuleAsk(q);};
exportReport=function(...args){if(datasetBlocked()){toast('请先恢复数据或重新上传。');return;}return originalExportReport(...args);};
function setImportMessage(message,error=false){$('#importMessage').textContent=message;$('#importMessage').className='import-message'+(error?' error':'');}
function setImportBusy(busy){importBusy=busy;$('#parseImport').disabled=busy;$('#confirmImport').disabled=busy;$('#cancelImport').disabled=busy;$('#importTable').disabled=busy;document.querySelectorAll('[data-map-field]').forEach(el=>el.disabled=busy);}
async function datasetRequest(path,{method='GET',body,signal}={}){
  const headers={};
  if(method!=='GET'){
    const response=await fetch('/api/session',{credentials:'same-origin',cache:'no-store',signal});
    const value=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(new Error(value.message||'请先解锁工作空间，再上传数据。'),{code:value.code||'ACCESS_REQUIRED',status:response.status});
    headers['X-Datalens-Session']=value.session;headers['Content-Type']='application/json';
  }
  const response=await fetch(path,{method,headers,credentials:'same-origin',cache:'no-store',...(body?{body:JSON.stringify(body)}:{}),signal});
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(value.message||'数据服务暂时不可用，请稍后重试。'),{code:value.code,status:response.status});
  return value;
}
function currentImportTable(){return importDraft?.tables.find(table=>table.name===$('#importTable').value);}
function renderMapping(){
  const table=currentImportTable();if(!table)return;
  const names=table.columns.map(column=>typeof column==='string'?column:column.name);
  $('#mappingFields').innerHTML=Object.entries(fieldLabels).map(([field,label])=>`<label>${label}<span>${field}</span><select data-map-field="${field}" aria-label="${label}对应字段"><option value="">选择列…</option>${names.map(name=>`<option value="${esc(name)}" ${table.mapping?.[field]===name?'selected':''}>${esc(name)}</option>`).join('')}</select></label>`).join('');
  $('#tablePreview').innerHTML=`<div class="preview-caption">${num(table.rowCount)} 行 · ${names.length} 列 · 预览前 ${Math.min(3,table.preview?.length||0)} 行</div><div class="table-wrap"><table><thead><tr>${names.map(name=>`<th>${esc(name)}</th>`).join('')}</tr></thead><tbody>${(table.preview||[]).slice(0,3).map(row=>`<tr>${names.map((name,index)=>`<td>${esc(Array.isArray(row)?row[index]:row[name])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  setImportMessage('请确认 6 项指标对应的列。其他列不会进入分析数据集。');
}
$('#importTable').onchange=renderMapping;
$('#importBtn').onclick=()=>{if(importBusy){toast('正在处理数据，请稍候');return;}$('#fileInput').click();};
$('#fileInput').onchange=async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;
  if(file.size>1048576){toast('文件超过 1 MB，请缩小后再上传。');return;}
  if(!/\.(csv|sql)$/i.test(file.name)){toast('请选择 CSV 或 SQL 文件。');return;}
  importFile=file;importDraft=null;importEpoch++;
  $('#importFileName').textContent=file.name;$('#importFileSize').textContent=`${Math.max(1,Math.round(file.size/1024))} KB · ${/\.sql$/i.test(file.name)?'SQL 数据导出':'CSV 表格'}`;
  $('#importDialog .import-disclosure').textContent=location.protocol==='file:'||modelStatus?.available===false?'当前为静态模式，CSV 仅在浏览器内存中解析，支持本地规则问数。SQL 导入与真实 AI 分析需要运行本地服务或使用已部署的网站。':'点击解析后，文件将上传并在服务端临时保存。仅选中的 6 项业务字段用于分析；发起真实 AI 问数时，会把问题、字段口径与聚合结果发送至 DeepSeek。请使用已脱敏的数据。';
  $('#mappingStep').hidden=true;$('#confirmImport').hidden=true;$('#parseImport').hidden=false;$('#importProgress').textContent='01 / 选择文件';
  setImportBusy(false);setImportMessage('解析后可选择数据表并确认字段，不会立即替换当前数据。');$('#importDialog').showModal();
};
$('#cancelImport').onclick=()=>{if(!importBusy){importEpoch++;$('#importDialog').close();importFile=null;importDraft=null;}};
$('#importDialog').addEventListener('cancel',event=>{if(importBusy)event.preventDefault();else importEpoch++;});
$('#parseImport').onclick=async()=>{
  if(importBusy||!importFile)return;
  const epoch=importEpoch,file=importFile;setImportBusy(true);setImportMessage('正在读取并解析数据…');runId++;answerState=null;
  try{
    const format=/\.sql$/i.test(file.name)?'sql':'csv',content=await file.text();
    if(location.protocol==='file:'||modelStatus?.available===false){
      if(format==='sql')throw new Error('SQL 导入需要运行本地服务或使用已部署的网站。静态模式支持本地 CSV。');
      const value=DL.validateCSV(content);if(value.errors.length)throw new Error(value.errors.slice(0,4).join('；'));
      runId++;answerState=null;rows=value.rows;activeDataset={name:file.name,format:'csv',kind:'local'};source='本地 CSV：'+file.name;datasetUnavailable=false;datasetRestoring=false;state={days:7,channel:'all'};rememberDataset();initChannels();render();$('#importDialog').close();toast('CSV 已载入本地规则模式；真实 AI 分析需要运行服务。');return;
    }
    if(accessLocked())throw new Error('请先在“模型连接”中输入访问码，解锁后可上传数据。');
    const draft=await datasetRequest('/api/imports',{method:'POST',body:{filename:file.name,format,content},signal:AbortSignal.timeout(20000)});
    if(epoch!==importEpoch)return;
    if(!draft.tables?.length)throw new Error('未找到可导入的数据表。');
    importDraft=draft;$('#importTable').innerHTML=draft.tables.map(table=>`<option value="${esc(table.name)}">${esc(table.name)} · ${num(table.rowCount)} 行</option>`).join('');
    $('#mappingStep').hidden=false;$('#parseImport').hidden=true;$('#confirmImport').hidden=false;$('#importProgress').textContent='02 / 确认字段';renderMapping();
  }catch(error){if(epoch===importEpoch)setImportMessage(error.message||'解析失败，原数据已保留。',true);}
  finally{setImportBusy(false);}
};
$('#confirmImport').onclick=async()=>{
  if(importBusy||!importDraft)return;
  const mapping=Object.fromEntries([...document.querySelectorAll('[data-map-field]')].map(el=>[el.dataset.mapField,el.value]));
  if(Object.values(mapping).some(value=>!value)||new Set(Object.values(mapping)).size!==6){setImportMessage('请为 6 项指标选择不同的数据列。',true);return;}
  const epoch=importEpoch;setImportBusy(true);setImportMessage('正在校验数据并创建分析数据集…');runId++;answerState=null;
  try{
    const value=await datasetRequest('/api/datasets',{method:'POST',body:{importId:importDraft.importId,table:$('#importTable').value,mapping},signal:AbortSignal.timeout(20000)});
    if(epoch!==importEpoch)return;
    if(!value.dataset?.id||!value.rows?.length)throw new Error('数据集未返回有效记录，原数据已保留。');
    runId++;answerState=null;activeDataset=value.dataset;rows=value.rows;source='自定义数据：'+activeDataset.name;datasetUnavailable=false;datasetRestoring=false;state={days:7,channel:'all'};rememberDataset();initChannels();render();$('#importDialog').close();
    $('#importResult').textContent=`已载入 ${num(rows.length)} 行 · 可以使用相同的 AI 分析流程。`;$('#importResult').style.color='var(--green)';toast('数据已就绪，可以前往 AI 问数');importDraft=null;importFile=null;
  }catch(error){if(epoch===importEpoch)setImportMessage(error.message||'导入失败，原数据已保留。',true);}
  finally{setImportBusy(false);}
};
$('#resetData').onclick=async()=>{
  if(importBusy)return;
  if(activeDataset?.id){
    setImportBusy(true);
    try{await datasetRequest('/api/datasets/'+encodeURIComponent(activeDataset.id),{method:'DELETE',body:{},signal:AbortSignal.timeout(10000)});}
    catch(error){if(![401,404,410].includes(error.status)){toast('暂时无法清理上传数据，请重试。');setImportBusy(false);return;}}
    finally{setImportBusy(false);}
  }
  importEpoch++;runId++;activeDataset=null;datasetUnavailable=false;datasetRestoring=false;rows=DL.sample();source='固定模拟数据';state={days:7,channel:'all'};answerState=null;rememberDataset();initChannels();render();$('#importResult').textContent='已切换为固定模拟数据。';toast('已恢复模拟数据');
};
async function restoreDataset(){
  let id;try{id=sessionStorage.getItem(DATASET_KEY);}catch{}
  if(!id){render();return;}
  activeDataset={id,name:'自定义数据'};datasetRestoring=true;render();
  try{
    const value=await datasetRequest('/api/datasets/'+encodeURIComponent(id),{signal:AbortSignal.timeout(15000)});
    if(activeDataset?.id!==id)return;
    if(!value.rows?.length||!value.dataset?.id)throw new Error();
    activeDataset=value.dataset;rows=value.rows;source='自定义数据：'+activeDataset.name;initChannels();
  }catch{if(activeDataset?.id===id){rows=[];datasetUnavailable=true;source='自定义数据不可用';}}
  finally{datasetRestoring=false;render();}
}
/* One focusable chart supports pointer exploration and keyboard arrows. */
renderChart=function(){
  const a=analysis,complete=readyComparison(a),series=a.series.map(day=>({...day,gmv:day.complete?day.gmv:null,previousGmv:complete&&day.previousComplete?day.previousGmv:null}));
  const W=700,H=240,L=50,R=16,T=22,B=36,max=Math.max(1,...series.flatMap(day=>[day.gmv||0,day.previousGmv||0]))*1.15;
  const x=i=>L+i*(W-L-R)/Math.max(series.length-1,1),y=value=>T+(H-T-B)*(1-value/max);
  function path(key){let open=false;return series.map((day,i)=>{if(day[key]==null){open=false;return '';}const value=(open?'L':'M')+x(i)+','+y(day[key]);open=true;return value;}).join(' ');}
  const ticks=Array.from({length:5},(_,i)=>{const value=max*i/4;return `<line x1="${L}" y1="${y(value)}" x2="${W-R}" y2="${y(value)}" class="chart-grid"/><text x="${L-10}" y="${y(value)+4}" text-anchor="end" class="chart-axis">${value>=10000?(value/10000).toFixed(1)+'万':Math.round(value)}</text>`;}).join('');
  const labels=series.map((day,i)=>i===0||i===series.length-1||i%Math.max(1,Math.floor(series.length/6))===0?`<text x="${x(i)}" y="${H-10}" text-anchor="middle" class="chart-axis">${day.date.slice(5).replace('-','/')}</text>`:'').join('');
  const area=series.length&&series.every(day=>day.gmv!=null)?`<path d="${path('gmv')} L${x(series.length-1)},${H-B} L${x(0)},${H-B}Z" fill="url(#areaGradient)"/>`:'';
  $('#trendChart').innerHTML=`<div class="chart-explorer"><svg viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="成交金额趋势。使用左右方向键查看每日数值。"><defs><linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#5ed8e7" stop-opacity=".2"/><stop offset="1" stop-color="#5ed8e7" stop-opacity="0"/></linearGradient></defs>${ticks}${area}${complete?`<path d="${path('previousGmv')}" class="chart-prior"/>`:''}<path d="${path('gmv')}" class="chart-current"/>${series.map((day,i)=>day.gmv==null?'':`<circle cx="${x(i)}" cy="${y(day.gmv)}" r="3" class="chart-dot"/>`).join('')}${labels}<g id="chartCursor" visibility="hidden"><line y1="${T}" y2="${H-B}" class="chart-cursor"/><circle r="5" class="chart-focus"/></g></svg><div class="chart-tooltip" id="chartTooltip" hidden></div></div>`;
  const svg=$('#trendChart svg'),cursor=$('#chartCursor'),tip=$('#chartTooltip');let selected=0;
  function highlight(index){selected=Math.max(0,Math.min(series.length-1,index));const day=series[selected];if(!day)return;cursor.setAttribute('visibility','visible');const line=cursor.querySelector('line');line.setAttribute('x1',x(selected));line.setAttribute('x2',x(selected));const dot=cursor.querySelector('circle');dot.setAttribute('cx',x(selected));dot.setAttribute('cy',y(day.gmv||0));dot.style.display=day.gmv==null?'none':'';tip.hidden=false;tip.innerHTML=`<strong>${day.date}</strong><span><i></i>当期 <b>${day.gmv==null?'记录缺失':money2(day.gmv)}</b></span>${complete?`<span class="prior">上期对应日 <b>${money2(day.previousGmv)}</b></span>`:'<span class="prior">对比覆盖不足</span>'}`;tip.style.left=Math.min(78,Math.max(5,x(selected)/W*100))+'%';}
  svg.addEventListener('pointermove',event=>{const rect=svg.getBoundingClientRect(),position=(event.clientX-rect.left)/rect.width*W;highlight(Math.round((position-L)/(W-L-R)*(series.length-1)));});
  svg.addEventListener('pointerleave',()=>{cursor.setAttribute('visibility','hidden');tip.hidden=true;});
  svg.addEventListener('focus',()=>highlight(selected));svg.addEventListener('blur',()=>{cursor.setAttribute('visibility','hidden');tip.hidden=true;});svg.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();highlight(selected+(event.key==='ArrowRight'?1:-1));}});
  document.querySelector('.legend .previous')?.parentElement.toggleAttribute('hidden',!complete);
  const worst=complete?worstChannel(a):null;
  $('#chartInsight').innerHTML=icon('sparkles')+`<span>${complete?`GMV 较上期 ${change(a.delta.gmv)}。${worst?`${esc(worst.channel)}金额变动 ${signedMoney(worst.current.gmv-worst.previous.gmv)}，值得进一步核查。`:''}`:'当前或对比周期覆盖不足，趋势只呈现完整记录日，暂不输出环比。'}</span>`;
};
restoreDataset();
