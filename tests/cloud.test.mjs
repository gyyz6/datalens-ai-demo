import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, deploymentConfig } from '../server.mjs';

// Isolated HTTP tests; every credential and upstream response here is artificial.
const ORIGIN = 'https://demo.example';
const ACCESS = 'test-access-code-never-real';
const KEY = 'sk-test-never-real';
const input = { question: '分析 GMV', scope: { days: 7, channel: 'all' } };
const mockResponse = () => new Response(JSON.stringify({ choices: [{ message: {
  role: 'assistant', content: JSON.stringify({ status: 'unsupported' }),
} }] }), { status: 200 });

async function start(t, options = {}) {
  let calls = 0;
  const server = createServer({
    configLoader: async () => ({ apiKey: KEY, model: 'deepseek-flash' }),
    fetchImpl: async () => { calls += 1; return mockResponse(); },
    ...options,
    deploymentConfig: { mode: 'cloud', origin: ORIGIN, accessCode: ACCESS, maxAnalyses: 30, ...options.deploymentConfig },
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  function request(route, { method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method,
        headers: { Host: 'demo.example', ...headers } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  const post = (route, body, headers = {}) => request(route, {
    method: 'POST', body: JSON.stringify(body), headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
  });
  const login = async () => {
    const result = await post('/api/login', { accessCode: ACCESS });
    assert.equal(result.status, 200);
    const cookie = result.headers['set-cookie'][0].split(';')[0];
    const session = await request('/api/session', { headers: { Cookie: cookie } });
    assert.equal(session.status, 200);
    return { cookie, csrf: session.json.session, result };
  };
  const analyze = (auth, body = input, headers = {}) => post('/api/analyze', body, {
    Cookie: auth.cookie, 'X-Datalens-Session': auth.csrf, ...headers,
  });
  return { request, post, login, analyze, calls: () => calls };
}

test('cloud settings fail closed for missing secrets, unsafe origins and invalid budgets', () => {
  const good = { DEPLOYMENT_MODE: 'cloud', PUBLIC_ORIGIN: ORIGIN, DEMO_ACCESS_CODE: ACCESS };
  for (const env of [
    { ...good, PUBLIC_ORIGIN: undefined },
    { ...good, PUBLIC_ORIGIN: 'http://demo.example' },
    { ...good, PUBLIC_ORIGIN: 'https://demo.example/extra' },
    { ...good, PUBLIC_ORIGIN: 'https://demo.example?query=yes' },
    { ...good, PUBLIC_ORIGIN: 'https://user:password@demo.example' },
    { ...good, DEMO_ACCESS_CODE: undefined },
    { ...good, DEMO_ACCESS_CODE: 'short-code' },
    { ...good, DEMO_ACCESS_CODE: `${ACCESS}\n` },
    { ...good, DEEPSEEK_API_KEY: ACCESS },
    { ...good, DEMO_MAX_ANALYSES: '0' },
    { ...good, DEMO_MAX_ANALYSES: '101' },
    { ...good, DEMO_MAX_ANALYSES: '1.5' },
    { ...good, DEPLOYMENT_MODE: 'other' },
  ]) assert.throws(() => deploymentConfig(env));
  assert.throws(() => createServer({ deploymentConfig: { mode: 'cloud', origin: ORIGIN, accessCode: 'bad' } }));
  assert.equal(deploymentConfig(good).maxAnalyses, 30);
  assert.equal(deploymentConfig({ ...good, DEMO_MAX_ANALYSES: '100' }).maxAnalyses, 100);
  assert.equal(deploymentConfig({ ...good, PUBLIC_ORIGIN: undefined, RENDER_EXTERNAL_URL: ORIGIN }).origin, ORIGIN);
  assert.equal(deploymentConfig({ ...good, PUBLIC_ORIGIN: `${ORIGIN}/` }).origin, ORIGIN);
  assert.deepEqual(deploymentConfig({}, { mode: 'local' }), { mode: 'local' });
});

test('unauthenticated visitors can view safe status and health, but cannot obtain a session or analyze', async t => {
  const app = await start(t);
  const status = await app.request('/api/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.json, {
    deployment: 'cloud', authRequired: true, authenticated: false, configured: true,
    provider: 'deepseek', model: 'deepseek-flash', configFile: 'environment', sampleOnly: false, uploadsSupported: true,
  });
  for (const result of [await app.request('/api/session'), await app.post('/api/analyze', input)]) {
    assert.equal(result.status, 401); assert.equal(result.json.code, 'ACCESS_REQUIRED');
  }
  const health = await app.request('/healthz', { headers: { Host: 'internal-healthcheck' } });
  assert.equal(health.status, 200); assert.equal(health.text, 'ok');
  assert.equal(health.headers['set-cookie'], undefined);
  assert.equal(status.text.includes(KEY), false); assert.equal(status.text.includes(ACCESS), false);
  assert.equal(app.calls(), 0);
});

test('correct access code creates a private four-hour cookie and an individual CSRF session', async t => {
  const app = await start(t);
  const first = await app.login();
  assert.match(first.result.headers['set-cookie'][0], /^__Host-datalens-demo=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=14400$/);
  assert.match(first.csrf, /^[a-f0-9]{64}$/);
  assert.equal(first.cookie.includes(first.csrf), false);
  const second = await app.login();
  assert.notEqual(first.csrf, second.csrf);
  const status = await app.request('/api/status', { headers: { Cookie: first.cookie } });
  assert.equal(status.json.authenticated, true);
  assert.equal((await app.analyze(second, input, { 'X-Datalens-Session': first.csrf })).status, 403);
  const valid = await app.analyze(first);
  assert.equal(valid.status, 200); assert.equal(app.calls(), 1);
  assert.equal(JSON.stringify([first.result, status, valid]).includes(KEY), false);
  assert.equal(JSON.stringify([first.result, status, valid]).includes(ACCESS), false);
});

test('wrong access codes, malformed bodies and large bodies never echo inputs or create cookies', async t => {
  const app = await start(t);
  for (const body of [{ accessCode: KEY }, { accessCode: ACCESS, extra: true }, { accessCode: 123 }]) {
    const result = await app.post('/api/login', body);
    assert.equal(result.status, 401); assert.equal(result.json.code, 'LOGIN_FAILED');
    assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(result.text.includes(KEY), false); assert.equal(result.text.includes(ACCESS), false);
  }
  const malformed = await app.request('/api/login', {
    method: 'POST', body: `invalid ${KEY}`, headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
  });
  assert.equal(malformed.status, 400); assert.equal(malformed.text.includes(KEY), false);
  const large = await app.post('/api/login', { accessCode: 'x'.repeat(9000) });
  assert.equal(large.status, 413); assert.equal(app.calls(), 0);
});

test('login, session and analysis enforce the configured host/origin without trusting proxy headers', async t => {
  const app = await start(t);
  for (const headers of [
    { Origin: 'https://evil.example' },
    { Origin: 'http://demo.example' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { Host: 'evil.example', 'X-Forwarded-Host': 'demo.example', 'X-Forwarded-Proto': 'https' },
  ]) assert.equal((await app.post('/api/login', { accessCode: ACCESS }, headers)).status, 403);
  const missingOrigin = await app.request('/api/login', {
    method: 'POST', body: JSON.stringify({ accessCode: ACCESS }), headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(missingOrigin.status, 403);
  const auth = await app.login();
  for (const headers of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'X-Datalens-Session': '' }, { 'X-Datalens-Session': 'not-correct' }]) {
    assert.equal((await app.analyze(auth, input, headers)).status, 403);
  }
  assert.equal(app.calls(), 0);
});

test('a cross-site link from GitHub can open the public product page but cannot access APIs', async t => {
  const app = await start(t);
  const headers = { 'Sec-Fetch-Site': 'cross-site' };
  assert.equal((await app.request('/', { headers })).status, 200);
  assert.equal((await app.request('/index.html', { method: 'HEAD', headers })).status, 200);
  assert.equal((await app.request('/api/session', { headers })).status, 403);
  assert.equal(app.calls(), 0);
});

test('logout requires CSRF and revokes the old cookie and session immediately', async t => {
  const app = await start(t);
  const auth = await app.login();
  assert.equal((await app.post('/api/logout', {}, { Cookie: auth.cookie })).status, 403);
  const result = await app.post('/api/logout', {}, { Cookie: auth.cookie, 'X-Datalens-Session': auth.csrf });
  assert.equal(result.status, 200); assert.equal(result.json.authenticated, false);
  assert.match(result.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await app.request('/api/session', { headers: { Cookie: auth.cookie } })).status, 401);
  assert.equal((await app.analyze(auth)).json.code, 'ACCESS_REQUIRED');
  assert.equal(app.calls(), 0);
});

test('cloud analysis budget counts accepted failed attempts and cannot be bypassed with a new login', async t => {
  let upstreamCalls = 0;
  const app = await start(t, { deploymentConfig: { maxAnalyses: 1 }, fetchImpl: async () => {
    upstreamCalls += 1; return new Response(KEY, { status: 401 });
  } });
  const auth = await app.login();
  assert.equal((await app.analyze(auth, { ...input, rows: [] })).status, 400);
  assert.equal((await app.analyze(auth, input, { 'X-Datalens-Session': 'wrong' })).status, 403);
  assert.equal(upstreamCalls, 0);
  const failed = await app.analyze(auth);
  assert.equal(failed.json.code, 'AUTH_ERROR');
  assert.equal(failed.text.includes('.env'), false); assert.equal(failed.text.includes(KEY), false);
  const secondAuth = await app.login();
  const limited = await app.analyze(secondAuth);
  assert.equal(limited.status, 429); assert.equal(limited.json.code, 'DEMO_LIMIT');
  assert.equal(upstreamCalls, 1);
});

test('analysis budget is per server process instance and resets in a fresh instance', async t => {
  const first = await start(t, { deploymentConfig: { maxAnalyses: 1 } });
  const firstAuth = await first.login();
  assert.equal((await first.analyze(firstAuth)).status, 200);
  assert.equal((await first.analyze(firstAuth)).json.code, 'DEMO_LIMIT');
  const restarted = await start(t, { deploymentConfig: { maxAnalyses: 1 } });
  assert.equal((await restarted.analyze(await restarted.login())).status, 200);
  assert.equal(first.calls(), 1); assert.equal(restarted.calls(), 1);
});

test('cloud failed-login rate limit is global, including attempts claiming different forwarded IPs', async t => {
  const app = await start(t);
  for (let i = 0; i < 10; i += 1) {
    const wrong = await app.post('/api/login', { accessCode: 'wrong' }, { 'X-Forwarded-For': `10.0.0.${i}` });
    assert.equal(wrong.json.code, 'LOGIN_FAILED');
  }
  const limited = await app.post('/api/login', { accessCode: ACCESS });
  assert.equal(limited.status, 429); assert.equal(limited.json.code, 'LIMIT');
  assert.equal(limited.headers['set-cookie'], undefined); assert.equal(app.calls(), 0);
});

test('parallel incorrect logins share the same failure budget', async t => {
  const app = await start(t);
  const results = await Promise.all(Array.from({ length: 12 }, () => app.post('/api/login', { accessCode: 'wrong' })));
  assert.equal(results.filter(result => result.json.code === 'LOGIN_FAILED').length, 10);
  assert.equal(results.filter(result => result.json.code === 'LIMIT').length, 2);
  assert.equal(results.some(result => result.headers['set-cookie']), false);
});

test('cloud keeps the shared six-per-minute analysis limit', async t => {
  const app = await start(t);
  const auth = await app.login();
  for (let i = 0; i < 6; i += 1) assert.equal((await app.analyze(auth)).status, 200);
  const limited = await app.analyze(await app.login());
  assert.equal(limited.status, 429); assert.equal(limited.json.code, 'LIMIT'); assert.equal(app.calls(), 6);
});

test('session storage is bounded and evicts old cookies after one hundred active sessions', async t => {
  const app = await start(t);
  const oldest = await app.login();
  let latest;
  for (let i = 0; i < 100; i += 1) latest = await app.login();
  assert.equal((await app.request('/api/session', { headers: { Cookie: oldest.cookie } })).status, 401);
  assert.equal((await app.request('/api/session', { headers: { Cookie: latest.cookie } })).status, 200);
});

test('expired cloud sessions cannot obtain a nonce or start analysis', async t => {
  const app = await start(t);
  const auth = await app.login();
  const realNow = Date.now;
  const afterExpiry = realNow() + 4 * 60 * 60 * 1000 + 1;
  try {
    Date.now = () => afterExpiry;
    assert.equal((await app.request('/api/session', { headers: { Cookie: auth.cookie } })).status, 401);
    assert.equal((await app.analyze(auth)).json.code, 'ACCESS_REQUIRED');
  } finally { Date.now = realNow; }
  assert.equal(app.calls(), 0);
});

test('cloud static allowlist never serves environment, deployment config or source files', async t => {
  const app = await start(t);
  for (const route of ['/.env', '/.env.example', '/server.mjs', '/render.yaml', '/README.md', '/tests/cloud.test.mjs']) {
    const result = await app.request(route);
    assert.equal(result.status, 404); assert.equal(result.text.includes(KEY), false);
  }
  assert.equal((await app.request('/')).status, 200);
});

test('cloud environment loader exposes only safe status and supports unconfigured operation', async t => {
  const savedKey = process.env.DEEPSEEK_API_KEY;
  const savedModel = process.env.DEEPSEEK_MODEL;
  t.after(() => {
    if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = savedKey;
    if (savedModel === undefined) delete process.env.DEEPSEEK_MODEL; else process.env.DEEPSEEK_MODEL = savedModel;
  });
  process.env.DEEPSEEK_API_KEY = KEY;
  process.env.DEEPSEEK_MODEL = 'deepseek-flash';
  const app = await start(t, { configLoader: undefined });
  const status = await app.request('/api/status');
  assert.equal(status.json.configured, true); assert.equal(status.text.includes(KEY), false);
  delete process.env.DEEPSEEK_API_KEY;
  assert.equal((await app.request('/api/status')).json.configured, false);
  const missing = await app.analyze(await app.login());
  assert.equal(missing.json.code, 'CONFIG_MISSING'); assert.equal(missing.text.includes('.env'), false);
  assert.equal(app.calls(), 0);
});
