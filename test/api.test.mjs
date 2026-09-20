import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.mjs';

const T0 = Date.parse('2026-09-20T08:00:00.000Z');
const DEADLINE = '2026-09-27T08:00:00.000Z';

async function startServer(context) {
  const server = createServer({ clock: () => T0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function call(method, path, { actor = 'official-root', body } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(actor ? { 'x-actor-id': actor } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  return { call, base };
}

async function seedVillage(call) {
  const h1 = (await call('POST', '/admin/households', { body: { name: '张三家', groupId: '一组' } })).body;
  const h2 = (await call('POST', '/admin/households', { body: { name: '李四家', groupId: '一组' } })).body;
  const h3 = (await call('POST', '/admin/households', { body: { name: '王五家', groupId: '二组' } })).body;
  const m1 = (await call('POST', '/admin/actors', { body: { name: '张三', role: 'villager', householdId: h1.id } })).body;
  const m2 = (await call('POST', '/admin/actors', { body: { name: '李四', role: 'villager', householdId: h2.id } })).body;
  const m3 = (await call('POST', '/admin/actors', { body: { name: '王五', role: 'villager', householdId: h3.id } })).body;
  const ent = (await call('POST', '/admin/actors', { body: { name: '绿源公司', role: 'enterprise' } })).body;
  const p1 = (await call('POST', '/admin/plots', { body: { name: '后山杉木林', householdId: h1.id, area: 10 } })).body;
  const p2 = (await call('POST', '/admin/plots', { body: { name: '坳口松树林', householdId: h2.id, area: 8 } })).body;
  const p3 = (await call('POST', '/admin/plots', { body: { name: '沿河杂木林', householdId: h3.id, area: 12 } })).body;
  return { h1, h2, h3, m1, m2, m3, ent, p1, p2, p3 };
}

async function makeProposal(call, ent, plots) {
  const created = await call('POST', '/proposals', {
    actor: ent.id,
    body: {
      title: '林下中药材种植流转方案',
      groupIds: ['一组', '二组'],
      plotIds: plots.map((p) => p.id),
      terms: { pricePerMu: 600, leaseYears: 20, guaranteedIncome: 300, exitTerms: '提前一年书面通知' },
      deadline: DEADLINE,
    },
  });
  await call('POST', `/proposals/${created.body.id}/publish`, { actor: ent.id });
  return created.body;
}

test('HTTP 端到端：建户建档 → 企业提案 → 农户表态 → 达标进入签署', async (context) => {
  const { call } = await startServer(context);
  const v = await seedVillage(call);
  const proposal = await makeProposal(call, v.ent, [v.p1, v.p2, v.p3]);

  assert.equal((await call('POST', `/proposals/${proposal.id}/statements`, { actor: v.m1.id, body: { stance: 'consent' } })).status, 201);
  assert.equal((await call('POST', `/proposals/${proposal.id}/statements`, { actor: v.m2.id, body: { stance: 'consent' } })).status, 201);

  const summary = await call('GET', `/proposals/${proposal.id}/summary`, { actor: 'official-root' });
  assert.equal(summary.body.quorumMet, true);
  assert.equal(summary.body.eligibleHouseholds, 3);

  const entered = await call('POST', `/proposals/${proposal.id}/enter-signing`, { actor: 'official-root' });
  assert.equal(entered.status, 200);
  assert.equal(entered.body.status, 'signing');

  const audit = await call('GET', `/proposals/${proposal.id}/audit`, { actor: 'official-root' });
  assert.deepEqual(
    audit.body.map((e) => e.type),
    ['proposal_created', 'version_created', 'proposal_published', 'statement_submitted', 'statement_submitted', 'entered_signing'],
  );
});

test('HTTP 鉴权与可见性：无身份 401，越权访问 403/404，家庭资料不外泄', async (context) => {
  const { call } = await startServer(context);
  const v = await seedVillage(call);
  const proposal = await makeProposal(call, v.ent, [v.p1, v.p2, v.p3]);
  await call('POST', `/proposals/${proposal.id}/statements`, { actor: v.m1.id, body: { stance: 'consent' } });

  // 未携带身份
  assert.equal((await call('GET', '/proposals', { actor: null })).status, 401);
  // 伪造身份
  assert.equal((await call('GET', '/proposals', { actor: 'nobody' })).status === 401, true);
  // 农户不能维护基础资料
  assert.equal((await call('POST', '/admin/plots', { actor: v.m1.id, body: { name: 'x', householdId: v.h1.id, area: 1 } })).status, 403);
  // 农户不能查审计
  assert.equal((await call('GET', `/proposals/${proposal.id}/audit`, { actor: v.m1.id })).status, 403);
  // 农户汇总不含其他家庭明细
  const villagerSummary = await call('GET', `/proposals/${proposal.id}/summary`, { actor: v.m1.id });
  assert.equal('households' in villagerSummary.body, false);
  assert.equal(villagerSummary.body.ownHousehold.stance, 'consent');
  // 企业汇总只有聚合数字
  const entSummary = await call('GET', `/proposals/${proposal.id}/summary`, { actor: v.ent.id });
  assert.equal('households' in entSummary.body, false);
  // 企业方案详情不含家庭级地块归属
  const entView = await call('GET', `/proposals/${proposal.id}`, { actor: v.ent.id });
  assert.equal('plots' in entView.body.scope, false);
  // 村集体能看到完整地块归属
  const officialView = await call('GET', `/proposals/${proposal.id}`, { actor: 'official-root' });
  assert.equal(officialView.body.scope.plots.length, 3);
});

test('HTTP 并发改价：两个并发请求只有一个成功，另一个确定性 409', async (context) => {
  const { call } = await startServer(context);
  const v = await seedVillage(call);
  const proposal = await makeProposal(call, v.ent, [v.p1, v.p2, v.p3]);

  const terms = (price) => ({ pricePerMu: price, leaseYears: 20, guaranteedIncome: 300, exitTerms: '提前一年书面通知' });
  const [a, b] = await Promise.all([
    call('POST', `/proposals/${proposal.id}/versions`, { actor: v.ent.id, body: { expectedVersion: 1, terms: terms(650) } }),
    call('POST', `/proposals/${proposal.id}/versions`, { actor: v.ent.id, body: { expectedVersion: 1, terms: terms(700) } }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 409]);
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.body.error.code, 'VERSION_CONFLICT');
  assert.equal(loser.body.error.details.currentVersion, 2);

  const versions = await call('GET', `/proposals/${proposal.id}/versions`, { actor: v.ent.id });
  assert.equal(versions.body.length, 2);
  assert.equal(versions.body.filter((x) => x.current).length, 1);
});

test('HTTP 远程委托全流程：建委托 → 代表态 → 撤销后失效', async (context) => {
  const { call } = await startServer(context);
  const v = await seedVillage(call);
  const proposal = await makeProposal(call, v.ent, [v.p1, v.p2, v.p3]);

  const delegation = await call('POST', '/delegations', {
    actor: v.m3.id,
    body: {
      delegatorId: v.m3.id,
      delegateId: v.m1.id,
      actions: ['statement'],
      proposalIds: [proposal.id],
      validUntil: '2026-09-26T08:00:00.000Z',
    },
  });
  assert.equal(delegation.status, 201);

  const stated = await call('POST', `/proposals/${proposal.id}/statements`, {
    actor: v.m1.id,
    body: { stance: 'consent', onBehalfOf: v.m3.id },
  });
  assert.equal(stated.status, 201);
  assert.equal(stated.body.statement.submittedBy, 'delegate');

  await call('POST', `/delegations/${delegation.body.id}/revoke`, { actor: v.m3.id });
  const after = await call('POST', `/proposals/${proposal.id}/objections`, {
    actor: v.m1.id,
    body: { reason: 'test', onBehalfOf: v.m3.id },
  });
  assert.equal(after.body.error.code, 'DELEGATION_REVOKED');

  // 王五本人可随时查看自己的委托与表态
  const me = await call('GET', '/me', { actor: v.m3.id });
  assert.equal(me.body.delegations.length, 1);
  assert.equal(me.body.delegations[0].status, 'revoked');
});

test('HTTP 请求健壮性：非法 JSON 与未知路径返回确定错误', async (context) => {
  const { call, base } = await startServer(context);

  assert.equal((await call('GET', '/no-such-route')).status, 404);

  const badJson = await fetch(`${base}/proposals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-actor-id': 'official-root' },
    body: '{not-json',
  });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error.code, 'BAD_JSON');

  const missingFields = await call('POST', '/proposals', { body: { title: '缺字段' } });
  assert.equal(missingFields.status, 400);
  assert.equal(missingFields.body.error.code, 'VALIDATION');
});
