import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, runAnalysis, parseEnv } from '../server.mjs';
import { DL } from '../lib/engine.mjs';

// All upstream responses and keys below are artificial; this suite never calls DeepSeek.
const FAKE_KEY = 'sk-test-never-real';
const config = { apiKey: FAKE_KEY, model: 'deepseek-flash' };
const input = { question: 'GMV下降的可能原因是什么？', scope: { days: 7, channel: 'all' } };
const answer = {
  summary: '抖音投放的转化表现走弱，建议结合渠道对照核验。',
  hypotheses: ['待验证：流量质量变化可能影响转化。'],
  actions: ['核查落地页和人群明细后再决定是否调整投放。'],
  evidenceIds: ['E1'],
};
const toolCall = (name = 'query_metrics', args = input.scope, id = 'call_test') => ({
  id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});
function response(message, usage = { prompt_tokens: 50, completion_tokens: 20 }, finishReason = 'stop') {
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: finishReason }], usage }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
function fakeFlow(calls = [toolCall()], final = answer) {
  const seen = [];
  return {
    seen,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      seen.push({ url, options, body });
      return seen.length === 1
        ? response({ role: 'assistant', content: null, tool_calls: calls })
        : response({ role: 'assistant', content: JSON.stringify(final) });
    },
  };
}
async function startServer(t, options = {}) {
  const server = createServer({ deploymentConfig: { mode: 'local' }, configLoader: async () => config, ...options });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = (await (await fetch(`${origin}/api/session`)).json()).session;
  const post = (body = input, more = {}) => fetch(`${origin}/api/analyze`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Datalens-Session': session, ...more },
    body: JSON.stringify(body),
  });
  return { server, origin, session, post };
}
function rawGet(server, url, host) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: url,
      headers: { Host: host ?? `127.0.0.1:${server.address().port}` } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on('error', reject);
  });
}

test('missing key returns CONFIG_MISSING before any upstream call', async () => {
  let called = false;
  const result = await runAnalysis(input, {}, { fetchImpl: async () => { called = true; } });
  assert.equal(result.code, 'CONFIG_MISSING');
  assert.equal(called, false);
});

test('real tool protocol: selected calls, deterministic evidence, then JSON summary', async () => {
  const mock = fakeFlow([toolCall(), toolCall('compare_channels', input.scope, 'call_channels')]);
  const result = await runAnalysis(input, config, mock);
  assert.equal(result.status, 'ok');
  assert.equal(mock.seen.length, 2);
  assert.equal(mock.seen[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(mock.seen[0].options.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(mock.seen[0].body.thinking.type, 'disabled');
  assert.equal(mock.seen[0].body.max_tokens, 1200);
  assert.equal(mock.seen[1].body.max_tokens, 2000);
  assert.equal(mock.seen[1].body.response_format.type, 'json_object');
  const messages = mock.seen[1].body.messages;
  const assistant = messages.find(m => m.role === 'assistant');
  const executed = messages.filter(m => m.role === 'tool');
  assert.deepEqual(assistant.tool_calls.map(t => t.id), executed.map(t => t.tool_call_id));
  assert.equal(JSON.parse(executed[0].content).source, 'fixed_sample_data');
  assert.deepEqual(result.analysis, DL.analyze(DL.sample(), input.scope));
  assert.deepEqual(result.evidence.map(e => e.id), ['E1', 'E2']);
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 40 });
  assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
});

test('unsupported or invalid tool arguments are never executed', async t => {
  for (const [label, call] of [
    ['unknown tool', toolCall('run_shell')],
    ['extra key', toolCall('query_metrics', { ...input.scope, rows: [] })],
    ['bad date', toolCall('query_metrics', { days: 365, channel: 'all' })],
    ['type coercion', toolCall('query_metrics', { days: '7', channel: 'all' })],
    ['unknown channel', toolCall('query_metrics', { days: 7, channel: 'all; DROP TABLE' })],
    ['invalid JSON', toolCall('query_metrics', '{oops')],
  ]) await t.test(label, async () => {
    const mock = fakeFlow([call]);
    const result = await runAnalysis(input, config, mock);
    assert.equal(result.code, 'TOOL_INVALID'); assert.equal(mock.seen.length, 1);
    assert.equal(result.trace.some(item => item.step === '执行指标工具'), false);
  });
});

test('model cannot silently change the requested scope', async () => {
  const result = await runAnalysis(input, config, fakeFlow([toolCall('query_metrics', { days: 14, channel: 'all' })]));
  assert.equal(result.status, 'needs_clarification'); assert.equal(result.code, 'TOOL_SCOPE_MISMATCH');
});

test('no tools means no factual analysis; supported refusal statuses are preserved', async t => {
  for (const [content, expected] of [
    ['GMV下降了百分之十五', 'NO_EVIDENCE'],
    [JSON.stringify({ status: 'unsupported' }), 'UNSUPPORTED'],
    [JSON.stringify({ status: 'needs_clarification' }), 'NEEDS_CLARIFICATION'],
  ]) await t.test(expected, async () => {
    const result = await runAnalysis(input, config, { fetchImpl: async () => response({ role: 'assistant', content }) });
    assert.equal(result.code, expected); assert.equal(result.analysis, undefined);
  });
});

test('a fifth tool call is refused before execution', async () => {
  const calls = Array.from({ length: 5 }, (_, i) => toolCall('query_metrics', input.scope, `call_${i}`));
  const result = await runAnalysis(input, config, fakeFlow(calls));
  assert.equal(result.code, 'TOOL_LIMIT');
});

test('invented evidence IDs and numeric narrative are blocked with at most three requests', async t => {
  for (const [label, invalid] of [
    ['invented citation', { ...answer, evidenceIds: ['E999'] }],
    ['Arabic number', { ...answer, summary: 'GMV下降了15%。' }],
    ['Chinese quantity', { ...answer, summary: 'GMV下降了百分之十五。' }],
    ['secret echo', { ...answer, summary: `返回的密钥是${FAKE_KEY}` }],
    ['missing structure', { summary: '分析完成' }],
  ]) await t.test(label, async () => {
    const mock = fakeFlow([toolCall()], invalid);
    const result = await runAnalysis(input, config, mock);
    assert.equal(result.code, 'ANSWER_INVALID'); assert.equal(mock.seen.length, 3);
    assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
  });
});

test('relative periods and validation sequence are accepted without needless retry', async t => {
  for (const phrase of [
    '与上一周期相比，抖音投放转化表现走弱。',
    '前一周期的流量结构值得进一步核验。',
    '一个验证方向是核对流量来源，另一个是检查页面加载。',
    '第一步核对渠道趋势，第二步检查落地页。',
    '第1步核查数据口径。',
    '1. 核查落地页表现。',
    '上一周的表现可作为验证方向，本月还需要等待更多数据。',
  ]) await t.test(phrase, async () => {
    const mock = fakeFlow([toolCall()], { ...answer, summary: phrase });
    const result = await runAnalysis(input, config, mock);
    assert.equal(result.status, 'ok'); assert.equal(mock.seen.length, 2);
  });
});

test('concrete business quantities remain blocked after allowing ordinary prose', async t => {
  for (const phrase of [
    'GMV下降15%。', '转化率下降三个百分点。', '订单增加一百单。',
    '客单价为三百。', 'GMV为五十万。', 'ROAS为三点五。', '收入为一万元。',
    '消耗下降一半。', '访问量为三千。', '获得一百次访问。', '相比前一周期，GMV下降三成。',
  ]) await t.test(phrase, async () => {
    const mock = fakeFlow([toolCall()], { ...answer, summary: phrase });
    const result = await runAnalysis(input, config, mock);
    assert.equal(result.code, 'ANSWER_INVALID');
    assert.equal(result.trace.find(item => item.reason)?.reason, 'NUMERIC_NARRATIVE');
    assert.equal(JSON.stringify(result).includes(phrase), false);
  });
});

test('retry receives the failed draft and a specific issue, then can recover', async () => {
  const seen = [];
  const invalid = JSON.stringify({ ...answer, evidenceIds: ['invented'] });
  const fetchImpl = async (_url, options) => {
    seen.push(JSON.parse(options.body));
    if (seen.length === 1) return response({ role: 'assistant', content: null, tool_calls: [toolCall()] });
    return response({ role: 'assistant', content: seen.length === 2 ? invalid : JSON.stringify(answer) });
  };
  const result = await runAnalysis(input, config, { fetchImpl });
  assert.equal(result.status, 'ok'); assert.equal(seen.length, 3);
  const retry = seen[2].messages;
  assert.deepEqual(retry.at(-2), { role: 'assistant', content: invalid });
  assert.match(retry.at(-1).content, /无效引用/);
  assert.match(retry.at(-1).content, /E1/);
  assert.equal(result.trace.find(item => item.reason)?.reason, 'EVIDENCE_REFERENCE');
  assert.equal(JSON.stringify(result).includes('invented'), false);
});

test('finish_reason length is classified and repaired even if content parses', async () => {
  const seen = [];
  const fetchImpl = async (_url, options) => {
    seen.push(JSON.parse(options.body));
    if (seen.length === 1) return response({ role: 'assistant', content: null, tool_calls: [toolCall()] });
    return response({ role: 'assistant', content: JSON.stringify(answer) }, undefined, seen.length === 2 ? 'length' : 'stop');
  };
  const result = await runAnalysis(input, config, { fetchImpl });
  assert.equal(result.status, 'ok'); assert.equal(seen.length, 3);
  assert.equal(result.trace.find(item => item.reason)?.reason, 'TRUNCATED');
  assert.match(seen[2].messages.at(-1).content, /截断/);
});

test('credential echoes, including JSON escaped ones, are never retransmitted or exposed', async t => {
  for (const escaped of [false, true]) await t.test(escaped ? 'escaped' : 'literal', async () => {
    const seen = [];
    let draft = JSON.stringify({ ...answer, summary: `敏感内容${FAKE_KEY}` });
    if (escaped) draft = draft.replace('sk-test-never-real', '\\u0073k-test-never-real');
    const fetchImpl = async (_url, options) => {
      seen.push(JSON.parse(options.body));
      if (seen.length === 1) return response({ role: 'assistant', content: null, tool_calls: [toolCall()] });
      return response({ role: 'assistant', content: seen.length === 2 ? draft : JSON.stringify(answer) });
    };
    const result = await runAnalysis(input, config, { fetchImpl });
    assert.equal(result.status, 'ok');
    assert.equal(result.trace.find(item => item.reason)?.reason, 'SECRET_ECHO');
    assert.equal(seen[2].messages.some(message => message.content === draft), false);
    assert.equal(JSON.stringify(seen[2]).includes(FAKE_KEY), false);
    assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
  });
});

test('401 response and network exception never leak upstream details or key', async t => {
  for (const [label, fetchImpl, code] of [
    ['unauthorized', async () => new Response(`invalid API key ${FAKE_KEY}`, { status: 401 }), 'AUTH_ERROR'],
    ['network', async () => { throw new Error(`failed with authorization ${FAKE_KEY}`); }, 'API_NETWORK'],
  ]) await t.test(label, async () => {
    const result = await runAnalysis(input, config, { fetchImpl });
    assert.equal(result.code, code); assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
  });
});

test('network permission failures have actionable classification without raw exceptions', async t => {
  const makeError = code => Object.assign(new Error(`private network detail ${FAKE_KEY}`), { code });
  for (const [label, error] of [
    ['direct EACCES', makeError('EACCES')],
    ['nested EPERM', new TypeError('fetch failed', { cause: makeError('EPERM') })],
    ['aggregate child', new TypeError('fetch failed', { cause: new AggregateError([makeError('ECONNRESET'), makeError('EACCES')]) })],
  ]) await t.test(label, async () => {
    const result = await runAnalysis(input, config, { fetchImpl: async () => { throw error; } });
    assert.equal(result.code, 'API_NETWORK_PERMISSION');
    assert.match(result.message, /启动数见.cmd/); assert.match(result.message, /无需更换/);
    assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
  });
});

test('HTTP maps network permission failures to 502', async t => {
  const { post } = await startServer(t, { fetchImpl: async () => { throw Object.assign(new Error('blocked'), { code: 'EACCES' }); } });
  const result = await post(); assert.equal(result.status, 502); assert.equal((await result.json()).code, 'API_NETWORK_PERMISSION');
});

test('timeout stops a non-responsive upstream even when it ignores AbortSignal', async () => {
  const result = await runAnalysis(input, config, { timeoutMs: 15, fetchImpl: async () => new Promise(() => {}) });
  assert.equal(result.code, 'TIMEOUT');
});

test('caller supplied rows and unknown request fields are rejected before upstream', async () => {
  const mock = fakeFlow();
  const result = await runAnalysis({ ...input, rows: [{ gmv: 999 }] }, config, mock);
  assert.equal(result.code, 'BAD_REQUEST'); assert.equal(mock.seen.length, 0);
});

test('dotenv parser handles BOM, quotes, export and comments without expansion', () => {
  assert.deepEqual(parseEnv('\uFEFF# comment\n export DEEPSEEK_API_KEY="sk-local-test" # trailing\nDEEPSEEK_MODEL=deepseek-flash\nOTHER=$(ignored)\n'), {
    DEEPSEEK_API_KEY: 'sk-local-test', DEEPSEEK_MODEL: 'deepseek-flash', OTHER: '$(ignored)',
  });
});

test('HTTP status rereads configuration without revealing key and missing key is 503', async t => {
  let configured = false;
  const { origin, post } = await startServer(t, { configLoader: async () => configured ? config : {} });
  let status = await (await fetch(`${origin}/api/status`)).json();
  assert.equal(status.configured, false); assert.equal(status.sampleOnly, false); assert.equal(status.uploadsSupported, true);
  const missing = await post(); assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, 'CONFIG_MISSING');
  configured = true;
  status = await (await fetch(`${origin}/api/status`)).json();
  assert.equal(status.configured, true); assert.equal(JSON.stringify(status).includes(FAKE_KEY), false);
  assert.deepEqual(Object.keys(status).sort(), ['authRequired', 'authenticated', 'configFile', 'configured', 'deployment', 'model', 'provider', 'sampleOnly', 'uploadsSupported']);
  assert.equal(status.deployment, 'local'); assert.equal(status.authRequired, false); assert.equal(status.authenticated, true);
});

test('only public allowlisted files are served; secrets and path traversal fail', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'datalens-public-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await writeFile(path.join(temp, 'index.html'), '<h1>Public test page</h1>');
  await writeFile(path.join(temp, '.env'), `DEEPSEEK_API_KEY=${FAKE_KEY}`);
  await writeFile(path.join(temp, 'server.mjs'), 'private implementation');
  const { server, origin } = await startServer(t, { publicDir: temp });
  assert.equal((await fetch(origin)).status, 200);
  for (const route of ['/.env', '/server.mjs', '/lib/engine.mjs', '/tests/backend.test.mjs', '/../.env', '/%2e%2e/.env', '/%2eenv', '/public/.env']) {
    const response = await rawGet(server, route);
    assert.equal(response.status, 404, route); assert.equal(response.body.includes(FAKE_KEY), false, route);
  }
  const badHost = await rawGet(server, '/api/session', `evil.example:${server.address().port}`);
  assert.equal(badHost.status, 403);
  const result = await rawGet(server, '/');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.equal(result.headers['access-control-allow-origin'], undefined);
});

test('analyze requires both same-origin and unguessable session; HTTP enforces sample-only input', async t => {
  const mock = fakeFlow();
  const { origin, session, post } = await startServer(t, mock);
  const headers = { 'Content-Type': 'application/json', 'X-Datalens-Session': session };
  for (const requestHeaders of [headers, { ...headers, Origin: 'https://evil.example' }, { Origin: origin, 'Content-Type': 'application/json' }]) {
    const res = await fetch(`${origin}/api/analyze`, { method: 'POST', headers: requestHeaders, body: JSON.stringify(input) });
    assert.equal(res.status, 403);
  }
  assert.equal((await post(input, { 'X-Datalens-Session': 'é'.repeat(64) })).status, 403);
  assert.equal((await post({ ...input, rows: [] })).status, 400);
  assert.equal(mock.seen.length, 0);
  const success = await post(); assert.equal(success.status, 200); assert.equal((await success.json()).status, 'ok');
});

test('HTTP maps upstream authentication failure to 401', async t => {
  const { post } = await startServer(t, { fetchImpl: async () => new Response(FAKE_KEY, { status: 401 }) });
  const result = await post(); assert.equal(result.status, 401);
  const text = await result.text(); assert.equal(text.includes(FAKE_KEY), false); assert.equal(JSON.parse(text).code, 'AUTH_ERROR');
});

test('only one analysis runs at a time', async t => {
  let release;
  let signal;
  const started = new Promise(resolve => { signal = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const { post } = await startServer(t, { fetchImpl: async () => { signal(); await pending;
    return response({ role: 'assistant', content: JSON.stringify({ status: 'unsupported' }) });
  } });
  const first = post(); await started;
  const concurrent = await post(); assert.equal(concurrent.status, 429); assert.equal((await concurrent.json()).code, 'BUSY');
  release(); await first;
});

test('seventh analysis in a minute is limited locally', async t => {
  let calls = 0;
  const { post } = await startServer(t, { fetchImpl: async () => { calls += 1;
    return response({ role: 'assistant', content: JSON.stringify({ status: 'unsupported' }) });
  } });
  for (let i = 0; i < 6; i += 1) assert.equal((await post()).status, 200);
  const limited = await post(); assert.equal(limited.status, 429); assert.equal((await limited.json()).code, 'LIMIT');
  assert.equal(calls, 6);
});
