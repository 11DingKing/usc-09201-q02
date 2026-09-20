import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from '../src/domain/errors.mjs';
import { NegotiationService } from '../src/services/negotiation-service.mjs';
import { createStore } from '../src/store/memory-store.mjs';

const T0 = Date.parse('2026-09-20T08:00:00.000Z');
const DEADLINE = '2026-09-27T08:00:00.000Z';

/**
 * 标准村庄：两个村民小组、三户、四块地、两家公司。
 * 一组：h1（地块 p1、p1b），h2（地块 p2）；二组：h3（地块 p3）。
 */
function makeWorld() {
  const store = createStore();
  let now = T0;
  const service = new NegotiationService(store, () => now);
  const official = store.actors.get('official-root');

  const h1 = service.createHousehold(official, { name: '张三家', groupId: '一组' });
  const h2 = service.createHousehold(official, { name: '李四家', groupId: '一组' });
  const h3 = service.createHousehold(official, { name: '王五家', groupId: '二组' });
  const m1 = service.createActor(official, { name: '张三', role: 'villager', householdId: h1.id });
  const m1b = service.createActor(official, { name: '张三妻', role: 'villager', householdId: h1.id });
  const m2 = service.createActor(official, { name: '李四', role: 'villager', householdId: h2.id });
  const m3 = service.createActor(official, { name: '王五', role: 'villager', householdId: h3.id });
  const ent = service.createActor(official, { name: '绿源公司', role: 'enterprise' });
  const ent2 = service.createActor(official, { name: '丰林公司', role: 'enterprise' });
  const p1 = service.createPlot(official, { name: '后山杉木林', householdId: h1.id, area: 10 });
  const p1b = service.createPlot(official, { name: '沟边竹林', householdId: h1.id, area: 4 });
  const p2 = service.createPlot(official, { name: '坳口松树林', householdId: h2.id, area: 8 });
  const p3 = service.createPlot(official, { name: '沿河杂木林', householdId: h3.id, area: 12 });

  const world = {
    store,
    service,
    official,
    h1, h2, h3,
    m1, m1b, m2, m3,
    ent, ent2,
    p1, p1b, p2, p3,
    setNow(ms) { now = ms; },
  };
  return world;
}

function makeProposal(w, overrides = {}) {
  const created = w.service.createProposal(w.ent, {
    title: '林下中药材种植流转方案',
    groupIds: ['一组', '二组'],
    plotIds: [w.p1.id, w.p1b.id, w.p2.id, w.p3.id],
    terms: { pricePerMu: 600, leaseYears: 20, guaranteedIncome: 300, exitTerms: '提前一年书面通知' },
    deadline: DEADLINE,
    ...overrides,
  });
  w.service.publishProposal(w.ent, created.id);
  return created;
}

function assertDomainError(fn, code) {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof DomainError, `期望抛出 DomainError(${code})，实际：${error ?? '未抛出'}`);
  assert.equal(error.code, code, `期望错误码 ${code}，实际为 ${error.code}`);
  return error;
}

// ---------------------------------------------------------------- 法定参与条件

test('跨村民小组方案：按户统计参与，达到双三分之二后可进入签署', (t) => {
  const w = makeWorld();
  const proposal = makeProposal(w);

  // 三户中两户参与（一组两户 + 二组一户，共三户应参与）
  w.service.submitStatement(w.m1, proposal.id, { stance: 'consent' });
  w.service.submitStatement(w.m2, proposal.id, { stance: 'consent' });

  const summary = w.service.getSummary(w.official, proposal.id);
  assert.equal(summary.eligibleHouseholds, 3);
  assert.equal(summary.participatedHouseholds, 2);
  assert.equal(summary.consentingHouseholds, 2);
  assert.equal(summary.participationMet, true); // 2*3 >= 3*2
  assert.equal(summary.consentMet, true); // 2*3 >= 2*2
  assert.equal(summary.quorumMet, true);
  assert.deepEqual(
    summary.byGroup,
    [
      { groupId: '一组', eligible: 2, participated: 2, consenting: 2 },
      { groupId: '二组', eligible: 1, participated: 0, consenting: 0 },
    ],
  );

  const entered = w.service.enterSigning(w.official, proposal.id);
  assert.equal(entered.status, 'signing');
  assert.ok(entered.currentVersion.finalizedAt, '进入签署时最终文本应定版留痕');

  // 签署阶段冻结一切参与性变更
  assertDomainError(() => w.service.submitStatement(w.m3, proposal.id, { stance: 'consent' }), 'INVALID_STATUS');
  assertDomainError(() => w.service.exitPlots(w.m1, proposal.id, { plotIds: [w.p1.id] }), 'INVALID_STATUS');
});

test('参与户不足时禁止进入签署，并给出确定性差额', () => {
  const w = makeWorld();
  const proposal = makeProposal(w);
  w.service.submitStatement(w.m1, proposal.id, { stance: 'consent' });

  const error = assertDomainError(() => w.service.enterSigning(w.official, proposal.id), 'QUORUM_NOT_MET');
  assert.deepEqual(error.details, {
    eligibleHouseholds: 3,
    participatedHouseholds: 1,
    consentingHouseholds: 1,
    participationMet: false,
    consentMet: true,
    quorum: { participationNum: 2, participationDen: 3, consentNum: 2, consentDen: 3 },
  });
});

test('同意比例不足同样阻断签署（反对票计入参与但不计入同意）', () => {
  const w = makeWorld();
  const proposal = makeProposal(w);
  w.service.submitStatement(w.m1, proposal.id, { stance: 'consent' });
  w.service.submitStatement(w.m2, proposal.id, { stance: 'dissent' });

  const summary = w.service.getSummary(w.official, proposal.id);
  assert.equal(summary.participationMet, true);
  assert.equal(summary.consentMet, false); // 1*3 < 2*2
  assertDomainError(() => w.service.enterSigning(w.official, proposal.id), 'QUORUM_NOT_MET');
});

test('一户多人先后表态时，以最新有效表态确定该户立场', () => {
  const w = makeWorld();
  const proposal = makeProposal(w);
  w.service.submitStatement(w.m1, proposal.id, { stance: 'dissent' });
  w.service.submitStatement(w.m1b, proposal.id, { stance: 'consent' });
  w.service.submitStatement(w.m2, proposal.id, { stance: 'consent' });

  const summary = w.service.getSummary(w.official, proposal.id);
  assert.equal(summary.participatedHouseholds, 2);
  assert.equal(summary.consentingHouseholds, 2); // h1 以张三妻的同意为准
  assert.equal(summary.quorumMet, true);
});

// ---------------------------------------------------------------- 重复表态与撤回

test('重复表态：内容相同幂等返回，内容不同确定性拒绝', () => {
  const w = makeWorld();
  const proposal = makeProposal(w);
  const first = w.service.submitStatement(w.m1, proposal.id, { stance: 'consent', comment: '同意流转' });

  const again = w.service.submitStatement(w.m1, proposal.id, { stance: 'consent', comment: '同意流转' });
  assert.equal(again.duplicated, true);
  assert.equal(again.statement.id, first.statement.id);

  const changed = assertDomainError(
    () => w.service.submitStatement(w.m1, proposal.id, { stance: 'dissent' }),
    'DUPLICATE_STATEMENT',
  );
  assert.equal(changed.details.statementId, first.statement.id);

  // 汇总中该户仍只计一次
  const summary = w.service.getSummary(w.official, proposal.id);
  assert.equal(summary.participatedHouseholds, 1);
});

test('截止前可撤回并重新表态，截止后撤回与提交都被确定性拒绝', () => {
  const w = makeWorld();
  const proposal = makeProposal(w);
  const first = w.service.submitStatement(w.m1, proposal.id, { stance: 'dissent' });

  const withdrawn = w.service.withdrawStatement(w.m1, first.statement.id);
  assert.equal(withdrawn.status, 'withdrawn');
  assert.equal(w.service.getSummary(w.official, proposal.id).participatedHouseholds, 0);

  w.service.submitStatement(w.m1, proposal.id, { stance: 'consent' });
  assert.equal(w.service.getSummary(w.official, proposal.id).participatedHouseholds, 1);

  // 时间推进到截止之后
  w.setNow(Date.parse('2026-09-28T00:00:00.000Z'));
  assertDomainError(() => w.service.submitStatement(w.m2, proposal.id, { stance: 'consent' }), 'DEADLINE_PASSED');
  const current = w.service.listStatements(w.official, proposal.id).find((s) => s.status === 'active');
  assertDomainError(() => w.service.withdrawStatement(w.m1, current.id), 'DEADLINE_PASSED');
});

test('截止时间已过但参与条件满足时，村集体可评议后进入签署', () => {
  const w = makeWorld();
  const proposal = makeProposal(w);
  w.service.submitStatement(w.m1, proposal.id, { stance: 'consent' });
  w.service.submitStatement(w.m2, proposal.id, { stance: 'consent' });

  w.setNow(Date.parse('2026-09-28T00:00:00.000Z'));
  const entered = w.service.enterSigning(w.official, proposal.id);
  assert.equal(entered.status, 'signing');
});

// ---------------------------------------------------------------- 委托授权

test('远程委托：受托人代表态计入委托人所在户，到期后确定性失效', () => {
  const w = makeWorld();
  const proposal = makeProposal(w);
  const validUntil = '2026-09-23T08:00:00.000Z';
  w.service.createDelegation(w.m3, {
    delegatorId: w.m3.id,
    delegateId: w.m1.id,
    actions: ['statement'],
    proposalIds: [proposal.id],
    validUntil,
  });

  // 王五在外地，委托张三代为表态，计入王五家（二组）
  const result = w.service.submitStatement(w.m1, proposal.id, { stance: 'consent', onBehalfOf: w.m3.id });
  assert.equal(result.statement.submittedBy, 'delegate');
  // 张三看到的是匿名化委托人；村集体能看到完整身份
  assert.deepEqual(result.statement.principal, { role: 'villager', groupId: '二组' });
  const officialView = w.service.listStatements(w.official, proposal.id)[0];
  assert.equal(officialView.principal.actorId, w.m3.id);
  assert.equal(officialView.principal.householdId, w.h3.id);
  let summary = w.service.getSummary(w.official, proposal.id);
  assert.equal(summary.byGroup.find((g) => g.groupId === '二组').participated, 1);

  // 到期时刻仍有效（含端点），过一刻即失效
  w.setNow(Date.parse(validUntil));
  w.service.submitStatement(w.m2, proposal.id, { stance: 'consent' });
  w.setNow(Date.parse(validUntil) + 1);
  assertDomainError(
    () => w.service.submitStatement(w.m1, proposal.id, { stance: 'consent', onBehalfOf: w.m3.id }),
    'DELEGATION_EXPIRED',
  );

  // 已作出的表态不因委托到期而失效
  summary = w.service.getSummary(w.official, proposal.id);
  assert.equal(summary.participatedHouseholds, 2);
});

test('委托被撤销、事项或方案超出授权范围时，各自返回确定结果', () => {
  const w = makeWorld();
  const proposal = makeProposal(w);
  const delegation = w.service.createDelegation(w.m3, {
    delegatorId: w.m3.id,
    delegateId: w.m1.id,
    actions: ['statement'],
    proposalIds: null,
    validUntil: '2026-09-26T08:00:00.000Z',
  });

  // 事项超范围：该委托不含「退出地块」
  assertDomainError(
    () => w.service.exitPlots(w.m1, proposal.id, { plotIds: [w.p3.id], onBehalfOf: w.m3.id }),
    'DELEGATION_SCOPE',
  );

  // 方案超范围
  const other = makeProposal(w, { title: '另一方案' });
  const scoped = w.service.createDelegation(w.m2, {
    delegatorId: w.m2.id,
    delegateId: w.m1.id,
    actions: ['statement'],
    proposalIds: [proposal.id],
    validUntil: '2026-09-26T08:00:00.000Z',
  });
  assert.ok(scoped.id);
  assertDomainError(
    () => w.service.submitStatement(w.m1, other.id, { stance: 'consent', onBehalfOf: w.m2.id }),
    'DELEGATION_SCOPE',
  );

  // 撤销后确定性拒绝
  w.service.revokeDelegation(w.m3, delegation.id);
  assertDomainError(
    () => w.service.submitStatement(w.m1, proposal.id, { stance: 'consent', onBehalfOf: w.m3.id }),
    'DELEGATION_REVOKED',
  );

  // 重复建立有效委托被拒绝
  w.service.createDelegation(w.m1, {
    delegatorId: w.m1.id,
    delegateId: w.m2.id,
    actions: ['statement'],
    proposalIds: null,
    validUntil: '2026-09-26T08:00:00.000Z',
  });
  assertDomainError(
    () =>
      w.service.createDelegation(w.m1, {
        delegatorId: w.m1.id,
        delegateId: w.m2.id,
        actions: ['objection'],
        proposalIds: null,
        validUntil: '2026-09-26T08:00:00.000Z',
      }),
    'DELEGATION_EXISTS',
  );
});

// ---------------------------------------------------------------- 企业改价与版本

test('企业改价产生新版本：旧表态留痕不计入，并发改价只有一方成功', () => {
  const w = makeWorld();
  const proposal = makeProposal(w);
  w.service.submitStatement(w.m1, proposal.id, { stance: 'consent' });
  w.service.submitStatement(w.m2, proposal.id, { stance: 'consent' });
  assert.equal(w.service.getSummary(w.official, proposal.id).quorumMet, true);

  // 并发改价：两个请求都基于版本 1，先成功者升到版本 2，后到者确定性冲突
  const raisePrice = () =>
    w.service.createVersion(w.ent, proposal.id, {
      expectedVersion: 1,
      terms: { pricePerMu: 650, leaseYears: 20, guaranteedIncome: 300, exitTerms: '提前一年书面通知' },
    });
  const first = raisePrice();
  assert.equal(first.number, 2);
  const conflict = assertDomainError(raisePrice, 'VERSION_CONFLICT');
  assert.equal(conflict.details.currentVersion, 2);

  // 新版本上参与人数重新计算，旧表态留痕可查
  const summary = w.service.getSummary(w.official, proposal.id);
  assert.equal(summary.version.number, 2);
  assert.equal(summary.participatedHouseholds, 0);
  const history = w.service.listStatements(w.official, proposal.id);
  assert.equal(history.length, 2);
  assert.ok(history.every((s) => s.versionNumber === 1));

  // 农户在新版本上重新表态后计入
  w.service.submitStatement(w.m1, proposal.id, { stance: 'consent' });
  w.service.submitStatement(w.m2, proposal.id, { stance: 'consent' });
  assert.equal(w.service.getSummary(w.official, proposal.id).quorumMet, true);
});

test('只有发起方企业或村集体可以改价，另一家公司被确定性拒绝', () => {
  const w = makeWorld();
  const proposal = makeProposal(w);
  assertDomainError(
    () =>
      w.service.createVersion(w.ent2, proposal.id, {
        expectedVersion: 1,
        terms: { pricePerMu: 700, leaseYears: 20, guaranteedIncome: 300, exitTerms: '提前一年书面通知' },
      }),
    'FORBIDDEN',
  );
  // 另一家公司甚至看不到该方案
  assertDomainError(() => w.service.getProposal(w.ent2, proposal.id), 'NOT_FOUND');
});

// ---------------------------------------------------------------- 少数地块退出

test('少数地块退出：部分退出仍参与，全部退出后该户移出应参与基数', () => {
  const w = makeWorld();
  const proposal = makeProposal(w);

  // 张三家退出沟边竹林（少数地块），仍保留后山杉木林
  const partial = w.service.exitPlots(w.m1, proposal.id, { plotIds: [w.p1b.id] });
  assert.equal(partial.householdRemaining, 1);
  let summary = w.service.getSummary(w.official, proposal.id);
  assert.equal(summary.eligibleHouseholds, 3);
  assert.equal(summary.scope.plotCount, 3);

  // 张三家退出全部地块 → 应参与户从 3 降为 2
  const full = w.service.exitPlots(w.m1, proposal.id, { plotIds: [w.p1.id] });
  assert.equal(full.householdRemaining, 0);
  summary = w.service.getSummary(w.official, proposal.id);
  assert.equal(summary.eligibleHouseholds, 2);

  // 剩余两户同意即满足双三分之二
  w.service.submitStatement(w.m2, proposal.id, { stance: 'consent' });
  w.service.submitStatement(w.m3, proposal.id, { stance: 'consent' });
  assert.equal(w.service.getSummary(w.official, proposal.id).quorumMet, true);
  w.service.enterSigning(w.official, proposal.id);
});

test('退出他人地块、范围外地块都被确定性拒绝；全部退出后禁止签署', () => {
  const w = makeWorld();
  const proposal = makeProposal(w);

  assertDomainError(() => w.service.exitPlots(w.m1, proposal.id, { plotIds: [w.p2.id] }), 'NOT_PLOT_OWNER');

  w.service.exitPlots(w.m1, proposal.id, { plotIds: [w.p1.id, w.p1b.id] });
  assertDomainError(() => w.service.exitPlots(w.m1, proposal.id, { plotIds: [w.p1.id] }), 'PLOT_NOT_IN_SCOPE');
  // 已无范围内地块的户无权再表态
  assertDomainError(() => w.service.submitStatement(w.m1, proposal.id, { stance: 'consent' }), 'FORBIDDEN');

  w.service.exitPlots(w.m2, proposal.id, { plotIds: [w.p2.id] });
  w.service.exitPlots(w.m3, proposal.id, { plotIds: [w.p3.id] });
  assertDomainError(() => w.service.enterSigning(w.official, proposal.id), 'NO_ELIGIBLE_HOUSEHOLDS');
});

// ---------------------------------------------------------------- 异议留痕

test('异议全程留痕：提出、处理、撤回都有审计记录，且对非管理人匿名化', () => {
  const w = makeWorld();
  const proposal = makeProposal(w);

  const objection = w.service.raiseObjection(w.m3, proposal.id, { reason: '保底收益未写清调整机制' });
  assert.equal(objection.status, 'open');

  // 其他组农户只能看到匿名化的提出方
  const masked = w.service.listObjections(w.m1, proposal.id)[0];
  assert.deepEqual(masked.author, { role: 'villager', groupId: '二组' });
  assert.equal(masked.reason, '保底收益未写清调整机制');

  // 村集体看到完整信息并处理
  const officialView = w.service.listObjections(w.official, proposal.id)[0];
  assert.equal(officialView.author.name, '王五');
  w.service.resolveObjection(w.official, objection.id, { resolution: '已在第 2 版补充保底收益调整条款' });

  // 撤回路径同样留痕
  const second = w.service.raiseObjection(w.m2, proposal.id, { reason: '租期过长' });
  w.service.withdrawObjection(w.m2, second.id);

  const audit = w.service.getAudit(w.official, proposal.id);
  const types = audit.map((e) => e.type);
  assert.ok(types.includes('objection_raised'));
  assert.ok(types.includes('objection_resolved'));
  assert.ok(types.includes('objection_withdrawn'));
  assert.ok(audit.every((e, i) => i === 0 || e.seq > audit[i - 1].seq), '审计序号必须单调递增');

  // 异议人之外的角色不能处理异议
  assertDomainError(() => w.service.resolveObjection(w.ent, objection.id, { resolution: 'x' }), 'FORBIDDEN');
});

// ---------------------------------------------------------------- 汇总隐私

test('汇总结果按角色隔离：家庭明细仅村集体可见，企业只有聚合数字', () => {
  const w = makeWorld();
  const proposal = makeProposal(w);
  w.service.submitStatement(w.m1, proposal.id, { stance: 'consent' });
  w.service.submitStatement(w.m2, proposal.id, { stance: 'dissent' });

  const officialSummary = w.service.getSummary(w.official, proposal.id);
  assert.equal(officialSummary.households.length, 3);
  assert.equal(officialSummary.households.find((h) => h.householdId === w.h1.id).stance, 'consent');

  const villagerSummary = w.service.getSummary(w.m1, proposal.id);
  assert.equal('households' in villagerSummary, false, '农户不得看到其他家庭明细');
  assert.equal(villagerSummary.ownHousehold.stance, 'consent');
  assert.equal(villagerSummary.byStance.dissent, 1, '聚合数字可见');

  const enterpriseSummary = w.service.getSummary(w.ent, proposal.id);
  assert.equal('households' in enterpriseSummary, false);
  assert.equal('ownHousehold' in enterpriseSummary, false);
  assert.equal(enterpriseSummary.participatedHouseholds, 2);

  // 企业不能拉取家庭级表态明细
  assertDomainError(() => w.service.listStatements(w.ent, proposal.id), 'FORBIDDEN');
  // 农户只能看到本户表态
  const ownOnly = w.service.listStatements(w.m1, proposal.id);
  assert.equal(ownOnly.length, 1);
  assert.equal(ownOnly[0].principal.householdId, w.h1.id);
});

test('范围外农户与其他企业对方案不可见（按不存在处理）', () => {
  const w = makeWorld();
  const proposal = makeProposal(w);
  const h4 = w.service.createHousehold(w.official, { name: '赵六家', groupId: '三组' });
  const m4 = w.service.createActor(w.official, { name: '赵六', role: 'villager', householdId: h4.id });

  assertDomainError(() => w.service.getProposal(m4, proposal.id), 'NOT_FOUND');
  assertDomainError(() => w.service.getSummary(m4, proposal.id), 'NOT_FOUND');
  assertDomainError(() => w.service.submitStatement(m4, proposal.id, { stance: 'consent' }), 'NOT_FOUND');
  assertDomainError(() => w.service.getAudit(w.m1, proposal.id), 'FORBIDDEN');
  assert.equal(w.service.listProposals(m4).length, 0);
  assert.equal(w.service.listProposals(w.ent2).length, 0);
  assert.equal(w.service.listProposals(w.m1).length, 1);
});
