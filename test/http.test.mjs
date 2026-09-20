/**
 * 端到端：通过真实 HTTP 链路验证路由、角色头、Idempotency-Key 与并发改价/表态。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.mjs';
import { ManualClock } from '../src/domain/clock.mjs';

async function withServer(context) {
  const server = createServer({ clock: new ManualClock('2026-03-01T08:00:00.000Z') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, body, { role, actor, idem } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (role) headers['x-actor-role'] = role;
    if (actor) headers['x-actor-id'] = actor;
    if (idem) headers['idempotency-key'] = idem;
    const response = await fetch(base + path, {
      method,
      headers,
      ...(method === 'GET' ? {} : { body: body === undefined ? undefined : JSON.stringify(body) }),
    });
    const json = await response.json();
    return { status: response.status, json };
  }
  return { call, server };
}

const terms = {
  areaMu: 50,
  leaseYears: 10,
  guaranteedIncome: { amount: 80, currency: 'CNY', period: 'mu/year' },
  exitConditions: ['征用补偿按比例分配'],
};

async function seed(call) {
  await call('POST', '/api/companies', { companyId: 'CO_A', name: '青山公司' }, { role: 'collective' });
  for (const [hid, group, pid] of [['H1', '甲组', 'p1'], ['H2', '甲组', 'p3'], ['H3', '乙组', 'p5']]) {
    await call('POST', '/api/households', {
      householdId: hid, name: `${hid}号户`, group,
      members: [{ personId: pid, name: `${pid}某`, role: 'head' }],
    }, { role: 'collective' });
    await call('POST', '/api/plots', { plotId: `L${hid[1]}`, householdId: hid, group }, { role: 'collective' });
  }
  await call('POST', '/api/proposals', {
    proposalId: 'P1', scopePlotIds: ['L1', 'L2', 'L3'],
    deadline: '2026-03-20T00:00:00.000Z', terms,
  }, { role: 'company', actor: 'CO_A' });
}

test('HTTP：完整协商流程到定稿，错误返回稳定 code', async (context) => {
  const { call } = await withServer(context);
  await seed(call);

  // 无身份不能登记
  let r = await call('POST', '/api/households', { householdId: 'X' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'forbidden');

  // 截止时间非法
  r = await call('POST', '/api/proposals', {
    proposalId: 'P2', scopePlotIds: ['L1'], deadline: '2020-01-01T00:00:00.000Z', terms,
  }, { role: 'company', actor: 'CO_A' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'invalid_argument');

  // 三户同意
  for (const [hid, pid] of [['H1', 'p1'], ['H2', 'p3'], ['H3', 'p5']]) {
    const res = await call('POST', '/api/proposals/P1/statements', {
      householdId: hid, position: 'consent',
    }, { role: 'person', actor: pid });
    assert.equal(res.status, 201);
  }

  // 提案总览（公司视角，无户号）
  r = await call('GET', '/api/proposals/P1', null, { role: 'company', actor: 'CO_A' });
  assert.equal(r.status, 200);
  assert.equal(r.json.tally.consentCount, 3);
  assert.equal(r.json.tally.consented, undefined);

  // 公司看不到家庭明细
  r = await call('GET', '/api/households/H1', null, { role: 'company', actor: 'CO_A' });
  assert.equal(r.status, 403);

  // 未到截止不能定稿
  r = await call('POST', '/api/proposals/P1/finalization', {}, { role: 'collective' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'deadline_not_reached');
});

test('HTTP：Idempotency-Key 防重复表态', async (context) => {
  const { call } = await withServer(context);
  await seed(call);

  const payload = { householdId: 'H1', position: 'consent' };
  const a = await call('POST', '/api/proposals/P1/statements', payload, {
    role: 'person', actor: 'p1', idem: 'net-retry-1',
  });
  const b = await call('POST', '/api/proposals/P1/statements', payload, {
    role: 'person', actor: 'p1', idem: 'net-retry-1',
  });
  assert.equal(a.status, 201);
  assert.deepEqual(a.json, b.json);

  const tally = await call('GET', '/api/proposals/P1/group-tally', null, { role: 'collective' });
  assert.equal(tally.json.consentCount, 1);
});

test('HTTP：并发改价请求版本号连续无缺号，无并发写损坏', async (context) => {
  const { call } = await withServer(context);
  await seed(call);

  const results = await Promise.all([85, 90, 95].map((amount) =>
    call('POST', '/api/proposals/P1/revisions', {
      terms: { ...terms, guaranteedIncome: { amount, currency: 'CNY', period: 'mu/year' } },
    }, { role: 'company', actor: 'CO_A' })));

  const versions = results.map((r) => r.json.version).sort((a, b) => a - b);
  assert.deepEqual(versions, [2, 3, 4]);
  for (const r of results) assert.equal(r.status, 201);

  const view = await call('GET', '/api/proposals/P1', null, { role: 'collective' });
  assert.equal(view.json.versions.length, 4);
});

test('HTTP：远程委托到期经真实接口被拒，错误 details 给出判定依据', async (context) => {
  const { call, server } = await withServer(context);
  await seed(call);

  await call('POST', '/api/grants', {
    grantId: 'G1', householdId: 'H1', granterPersonId: 'p1', attorneyPersonId: 'p99',
    actions: ['statement'], expiresAt: '2026-03-10T00:00:00.000Z',
  }, { role: 'person', actor: 'p1' });

  server.clock.setTo('2026-03-11T00:00:00.000Z');
  const r = await call('POST', '/api/proposals/P1/statements', {
    householdId: 'H1', position: 'consent',
  }, { role: 'person', actor: 'p99' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'unauthorized');
  assert.equal(r.json.details.action, 'statement');
});
