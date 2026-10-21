import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, runAnalysis } from '../server.mjs';
import { DL } from '../lib/engine.mjs';

// All data, credentials, and upstream replies are synthetic. No model network call is made.
const config = { apiKey: 'sk-test-never-real', model: 'deepseek-flash' };
const fields = ['date', 'channel', 'sessions', 'orders', 'gmv', 'spend'];
const mapping = Object.fromEntries(fields.map(key => [key, key]));
const rows = Array.from({ length: 14 }, (_, index) => ({
  date: `2025-01-${String(index + 1).padStart(2, '0')}`, channel: '自营2025',
  sessions: 100, orders: 10, gmv: index < 7 ? 200 : 300, spend: 50,
}));
const scope = { days: 7, channel: 'all' };
const dataset = { id: 'a'.repeat(32), name: '私有文件.sql · sales', format: 'sql', kind: 'uploaded', rows };
const input = { question: '分析经营表现', scope, datasetId: dataset.id };
const finalAnswer = { summary: '自营2025的经营记录可用于复盘。', hypotheses: ['待验证：需结合业务明细进一步核查。'],
  actions: ['核对数据完整性后再决定行动。'], evidenceIds: ['E1'] };
const reply = message => new Response(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }), { status: 200 });
function mockFlow(options = {}) {
  const seen = [];
  return { seen, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); seen.push(body);
    if (body.tools) return reply({ role: 'assistant', content: null, tool_calls: (options.tools ?? ['query_metrics', 'compare_channels']).map((name, index) => ({
      id: `call_${index}`, type: 'function', function: { name, arguments: JSON.stringify(options.scope ?? scope) },
    })) });
    return reply({ role: 'assistant', content: JSON.stringify(options.answer ?? finalAnswer) });
  } };
}
const sql = `CREATE TABLE sales (date TEXT, channel TEXT, sessions INT, orders INT, gmv DECIMAL(12,2), spend DECIMAL(12,2), secret_note TEXT);
INSERT INTO sales (date,channel,sessions,orders,gmv,spend,secret_note) VALUES
${rows.map(row => `('${row.date}','${row.channel}',${row.sessions},${row.orders},${row.gmv},${row.spend},'PRIVATE_UNUSED_FIELD')`).join(',\n')};`;
async function start(t, options = {}) {
  const cloud = Boolean(options.cloud);
  const origin = cloud ? 'https://demo.example' : null;
  const mock = options.mock ?? mockFlow();
  const server = createServer({ configLoader: async () => config, fetchImpl: mock.fetchImpl,
    ...(options.now ? { now: options.now } : {}), ...(options.ttl ? { dataTtlMs: options.ttl } : {}),
    deploymentConfig: cloud ? { mode: 'cloud', origin, accessCode: 'test-access-code-never-real', maxAnalyses: 30 } : { mode: 'local' },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const actualOrigin = origin ?? `http://127.0.0.1:${server.address().port}`;
  const request = (route, { method = 'GET', body, auth, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method,
      headers: { Host: new URL(actualOrigin).host, Origin: actualOrigin, 'Content-Type': 'application/json',
        ...(auth ? { Cookie: auth.cookie, ...(auth.csrf ? { 'X-Datalens-Session': auth.csrf } : {}) } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); let json; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const session = async () => {
    let cookie;
    if (cloud) {
      const login = await request('/api/login', { method: 'POST', body: { accessCode: 'test-access-code-never-real' } });
      assert.equal(login.status, 200); cookie = login.headers['set-cookie'][0].split(';')[0];
    }
    const result = await request('/api/session', cookie ? { auth: { cookie } } : {});
    assert.equal(result.status, 200);
    return { cookie: cookie ?? result.headers['set-cookie'][0].split(';')[0], csrf: result.json.session };
  };
  const upload = async (auth, format = 'sql') => {
    const result = await request('/api/imports', { method: 'POST', auth, body: {
      filename: `sample.${format}`, format, content: format === 'sql' ? sql : DL.toCSV(rows),
    } });
    assert.equal(result.status, 200, result.text); return result.json;
  };
  const activate = async (auth, imported) => request('/api/datasets', { method: 'POST', auth,
    body: { importId: imported.importId, table: imported.tables[0].name, mapping } });
  return { request, session, upload, activate, mock };
}

test('custom dataset drives tool enum, actual date, totals and trace without raw SQL/extra fields', async () => {
  const mock = mockFlow();
  const result = await runAnalysis(input, config, { ...mock, dataset });
  assert.equal(result.status, 'ok');
  assert.equal(result.analysis.current.gmv, 2100); assert.equal(result.analysis.previous.gmv, 1400);
  assert.equal(result.analysis.range.end, '2025-01-14'); assert.equal(result.dataset.id, dataset.id);
  assert.deepEqual(mock.seen[0].tools[0].function.parameters.properties.channel.enum, ['all', '自营2025']);
  assert.match(mock.seen[0].messages[0].content, /2025-01-14/);
  assert.equal(mock.seen[0].messages[0].content.includes('私有文件.sql'), false);
  const tool = JSON.parse(mock.seen[1].messages.find(item => item.role === 'tool').content);
  assert.equal(tool.source, 'uploaded_dataset'); assert.equal(tool.datasetId, dataset.id);
  assert.equal(tool.result.current.gmv, 2100); assert.equal(JSON.stringify(mock.seen).includes('CREATE TABLE'), false);
});

test('unknown dataset is never substituted with sample data', async () => {
  const mock = mockFlow();
  assert.equal((await runAnalysis(input, config, mock)).code, 'DATASET_NOT_FOUND');
  assert.equal((await runAnalysis({ ...input, datasetId: 'b'.repeat(32) }, config, { ...mock, dataset })).code, 'DATASET_NOT_FOUND');
  assert.equal(mock.seen.length, 0);
});

test('custom channel scope is supported, stale sample channel is rejected', async () => {
  const channelScope = { days: 7, channel: '自营2025' };
  assert.equal((await runAnalysis({ ...input, scope: channelScope }, config, { ...mockFlow({ scope: channelScope }), dataset })).status, 'ok');
  assert.equal((await runAnalysis({ ...input, scope: { days: 7, channel: '抖音投放' } }, config, { ...mockFlow(), dataset })).code, 'BAD_REQUEST');
});

test('query_metrics is mandatory before model narrative', async () => {
  const mock = mockFlow({ tools: ['compare_channels'] });
  assert.equal((await runAnalysis(input, config, { ...mock, dataset })).code, 'NO_EVIDENCE');
  assert.equal(mock.seen.length, 1);
});

test('numeric channel label passes but measured numbers are still rejected', async () => {
  const mock = mockFlow({ answer: { ...finalAnswer, summary: '自营2025的GMV增长了50%。' } });
  assert.equal((await runAnalysis(input, config, { ...mock, dataset })).code, 'ANSWER_INVALID');
});

test('incomplete periods mask comparisons and model evidence and reject fabricated directional summary', async () => {
  const partial = { ...dataset, rows: rows.slice(-2) };
  const mock = mockFlow();
  const result = await runAnalysis(input, config, { ...mock, dataset: partial });
  assert.equal(result.status, 'ok'); assert.equal(result.analysis.quality.comparisonComplete, false);
  assert.equal(result.analysis.quality.currentComplete, false);
  assert.equal(result.analysis.current.gmv, 600); assert.equal(result.analysis.previous.gmv, null);
  assert.equal(result.analysis.delta.gmv, null); assert.equal(result.analysis.channels[0].contribution, null);
  const tool = JSON.parse(mock.seen[1].messages.find(item => item.role === 'tool').content);
  assert.equal(tool.result.previous.gmv, null); assert.ok(tool.result.quality.missingCells.length <= 10);
  const invalid = await runAnalysis(input, config, { ...mockFlow({ answer: { ...finalAnswer, summary: '自营2025的GMV上升。' } }), dataset: partial });
  assert.equal(invalid.code, 'ANSWER_INVALID');
});

test('tool payload channels are bounded while totals cover all uploaded channels', async () => {
  const wide = { ...dataset, rows: Array.from({ length: 25 }, (_, index) => rows.map(row => ({ ...row, channel: `品牌${index}` }))).flat() };
  const mock = mockFlow({ answer: { ...finalAnswer, summary: '渠道经营记录可用于复盘。' } }); const result = await runAnalysis(input, config, { ...mock, dataset: wide });
  assert.equal(result.status, 'ok'); assert.equal(result.analysis.channels.length, 25);
  assert.equal(result.analysis.current.gmv, 52500);
  const tool = JSON.parse(mock.seen[1].messages.find(item => item.role === 'tool').content);
  assert.equal(tool.result.channels.length, 20); assert.equal(tool.result.omittedChannels, 5);
});

test('SQL upload, mapping, refresh and full AI call retain only normalized fields', async t => {
  const app = await start(t); const auth = await app.session();
  const imported = await app.upload(auth);
  assert.equal(imported.tables[0].preview.length, 3); assert.equal(imported.tables[0].rowCount, 14);
  const active = await app.activate(auth, imported);
  assert.equal(active.status, 200, active.text); assert.equal(active.json.rows.length, 14);
  assert.deepEqual(Object.keys(active.json.rows[0]).sort(), [...fields].sort());
  const saved = await app.request(`/api/datasets/${active.json.dataset.id}`, { auth });
  assert.deepEqual(saved.json, active.json);
  const result = await app.request('/api/analyze', { method: 'POST', auth, body: { ...input, datasetId: active.json.dataset.id } });
  assert.equal(result.status, 200, result.text); assert.equal(result.json.analysis.current.gmv, 2100);
  assert.equal(JSON.stringify(app.mock.seen).includes('PRIVATE_UNUSED_FIELD'), false);
});

test('CSV uploads enter the same dataset and AI pipeline', async t => {
  const app = await start(t); const auth = await app.session();
  const active = await app.activate(auth, await app.upload(auth, 'csv'));
  assert.equal(active.status, 200, active.text); assert.equal(active.json.dataset.format, 'csv');
  const result = await app.request('/api/analyze', { method: 'POST', auth, body: { ...input, datasetId: active.json.dataset.id } });
  assert.equal(result.json.status, 'ok'); assert.equal(result.json.analysis.current.gmv, 2100);
});

test('local sessions isolate pending imports, data retrieval, analysis and deletion', async t => {
  const app = await start(t); const alice = await app.session(); const bob = await app.session();
  assert.notEqual(alice.cookie, bob.cookie);
  const imported = await app.upload(alice);
  assert.equal((await app.activate(bob, imported)).status, 404);
  const active = await app.activate(alice, imported); const id = active.json.dataset.id;
  assert.equal((await app.request(`/api/datasets/${id}`, { auth: bob })).status, 404);
  assert.equal((await app.request(`/api/datasets/${id}`, { auth: bob, method: 'DELETE' })).status, 404);
  assert.equal((await app.request('/api/analyze', { auth: bob, method: 'POST', body: { ...input, datasetId: id } })).status, 404);
  assert.equal(app.mock.seen.length, 0);
  assert.equal((await app.request(`/api/datasets/${id}`, { auth: alice, method: 'DELETE' })).status, 200);
  assert.equal((await app.request(`/api/datasets/${id}`, { auth: alice })).status, 404);
});

test('local demos on different ports keep separate cookies and do not overwrite dataset sessions', async t => {
  const first = await start(t); const second = await start(t);
  const authFirst = await first.session(); const authSecond = await second.session();
  assert.notEqual(authFirst.cookie.split('=')[0], authSecond.cookie.split('=')[0]);
  const firstActive = await first.activate(authFirst, await first.upload(authFirst));
  const secondActive = await second.activate(authSecond, await second.upload(authSecond));
  // A browser sends both host cookies to either port, so each app must select only its own name.
  const browserCookies = `${authFirst.cookie}; ${authSecond.cookie}`;
  assert.equal((await first.request(`/api/datasets/${firstActive.json.dataset.id}`, {
    auth: { ...authFirst, cookie: browserCookies },
  })).status, 200);
  assert.equal((await second.request(`/api/datasets/${secondActive.json.dataset.id}`, {
    auth: { ...authSecond, cookie: browserCookies },
  })).status, 200);
  assert.equal((await second.request(`/api/datasets/${firstActive.json.dataset.id}`, {
    auth: { ...authSecond, cookie: browserCookies },
  })).status, 404);
});

test('uploads require local cookie, correct origin and CSRF; oversized source is rejected', async t => {
  const app = await start(t); const auth = await app.session();
  const body = { filename: 'test.sql', format: 'sql', content: sql };
  assert.equal((await app.request('/api/imports', { method: 'POST', body, headers: { 'X-Datalens-Session': auth.csrf } })).status, 403);
  assert.equal((await app.request('/api/imports', { method: 'POST', body, auth, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await app.request('/api/imports', { method: 'POST', body, auth, headers: { 'X-Datalens-Session': 'invalid' } })).status, 403);
  assert.equal((await app.request('/api/imports', { method: 'POST', auth, body: { ...body, content: 'x'.repeat(1024 * 1024 + 1) } })).status, 413);
});

test('expired dataset fails closed and new upload replaces only its owner current data', async t => {
  let now = Date.now(); const app = await start(t, { now: () => now, ttl: 1000 }); const auth = await app.session();
  const active = await app.activate(auth, await app.upload(auth)); const id = active.json.dataset.id;
  now += 1001;
  assert.equal((await app.request(`/api/datasets/${id}`, { auth })).status, 404);
  assert.equal((await app.request('/api/analyze', { auth, method: 'POST', body: { ...input, datasetId: id } })).status, 404);
  assert.equal(app.mock.seen.length, 0);
  const fresh = await app.activate(auth, await app.upload(auth));
  assert.equal(fresh.status, 200); assert.notEqual(fresh.json.dataset.id, id);
});

test('cloud uploads require access code; logout destroys its uploaded data', async t => {
  const app = await start(t, { cloud: true });
  assert.equal((await app.request('/api/imports', { method: 'POST', body: { filename: 'sample.sql', format: 'sql', content: sql } })).status, 401);
  const alice = await app.session(); const bob = await app.session();
  const active = await app.activate(alice, await app.upload(alice)); const id = active.json.dataset.id;
  assert.equal((await app.request(`/api/datasets/${id}`, { auth: bob })).status, 404);
  assert.equal((await app.request('/api/logout', { method: 'POST', auth: alice, body: {} })).status, 200);
  assert.equal((await app.request(`/api/datasets/${id}`, { auth: alice })).status, 401);
  assert.equal((await app.request(`/api/datasets/${id}`, { auth: await app.session() })).status, 404);
});
