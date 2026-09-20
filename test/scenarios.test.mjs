/**
 * 村务公开前的核心场景检验：
 * 跨村民小组、远程委托失效、并发改价、地块退出、重复表态、截止前撤回、
 * 法定比例定稿、异议留痕、汇总脱敏。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from '../src/domain/errors.mjs';
import { baseTerms, COLLECTIVE, company, consent, harness, person, seedVillage } from './helpers.mjs';

const expectFail = (code) => (error) => {
  assert.ok(error instanceof DomainError, `应为 DomainError，实际：${error}`);
  assert.equal(error.code, code);
  return true;
};

// ---------------------------------------------------------------------------
// 1. 跨村民小组：参与人数、版本、异议留痕一致
// ---------------------------------------------------------------------------

test('跨村民小组：分组汇总人数与总数一致，定稿锁定同一版本', () => {
  const { clock, service } = harness();
  seedVillage(service);

  // 甲组 3 户全部同意；乙组 H4、H5 同意，H6 反对
  consent(service, 'P1', 'H1', 'p1');
  consent(service, 'P1', 'H2', 'p3');
  consent(service, 'P1', 'H3', 'p5');
  consent(service, 'P1', 'H4', 'p6');
  consent(service, 'P1', 'H5', 'p8');
  service.dispatch({
    type: 'make-statement', ctx: person('p9'),
    proposalId: 'P1', householdId: 'H6', actorPersonId: 'p9', position: 'oppose',
  });

  const tally = service.groupTallyView('P1', COLLECTIVE);
  const byGroup = Object.fromEntries(tally.groups.map((g) => [g.group, g]));
  assert.equal(byGroup['甲组'].totalHouseholds, 3);
  assert.equal(byGroup['甲组'].consentCount, 3);
  assert.equal(byGroup['乙组'].totalHouseholds, 3);
  assert.equal(byGroup['乙组'].consentCount, 2);
  assert.equal(byGroup['乙组'].opposeCount, 1);

  // 各组合计必须等于总计
  const sum = tally.groups.reduce((n, g) => n + g.totalHouseholds, 0);
  assert.equal(sum, tally.totalHouseholds);
  assert.equal(tally.totalHouseholds, 6);
  assert.equal(tally.consentCount, 5);

  // 5/6 >= 2/3，可定稿
  clock.setTo('2026-03-21T00:00:00.000Z');
  const fin = service.dispatch({ type: 'finalize-proposal', ctx: COLLECTIVE, proposalId: 'P1' });
  assert.equal(fin.version, 1);
  assert.equal(fin.consentCount, 5);
  assert.equal(fin.totalHouseholds, 6);

  const view = service.proposalView('P1', COLLECTIVE);
  assert.equal(view.status, 'finalized');
  assert.equal(view.finalized.version, tally.version);
  assert.deepEqual(view.finalized.terms, baseTerms());
});

// ---------------------------------------------------------------------------
// 2. 远程委托：到期 / 撤销 / 范围不覆盖都产生确定结果
// ---------------------------------------------------------------------------

test('远程委托到期：到期后不能代为表态，到期前作出的表态仍有效', () => {
  const { clock, service } = harness();
  seedVillage(service);

  service.dispatch({
    type: 'issue-grant', ctx: person('p4'),
    grantId: 'G1', householdId: 'H2', granterPersonId: 'p4', attorneyPersonId: 'p11',
    actions: ['statement'], expiresAt: '2026-03-10T00:00:00.000Z',
  });

  // 到期前：受托人可代为同意
  clock.setTo('2026-03-09T00:00:00.000Z');
  const r = consent(service, 'P1', 'H2', 'p11');
  assert.equal(r.version, 1);

  // 到期后：同一受托人再操作被拒
  clock.setTo('2026-03-11T00:00:00.000Z');
  assert.throws(
    () => consent(service, 'P1', 'H2', 'p11'),
    expectFail('unauthorized'),
  );

  // 到期前的表态仍计入
  const tally = service.groupTallyView('P1', COLLECTIVE);
  assert.ok(tally.groups.flatMap((g) => g.consented).includes('H2'));
});

test('委托撤销：撤销即时生效，不溯及既往', () => {
  const { service } = harness();
  seedVillage(service);

  service.dispatch({
    type: 'issue-grant', ctx: person('p2'),
    grantId: 'G2', householdId: 'H1', granterPersonId: 'p2', attorneyPersonId: 'p11',
    actions: ['statement', 'objection'], expiresAt: '2026-04-01T00:00:00.000Z',
  });
  consent(service, 'P1', 'H1', 'p11');
  service.dispatch({ type: 'revoke-grant', ctx: person('p2'), grantId: 'G2' });

  // 撤销后代为异议被拒
  assert.throws(
    () => service.dispatch({
      type: 'file-objection', ctx: person('p11'),
      proposalId: 'P1', householdId: 'H1', actorPersonId: 'p11',
      category: 'price', content: '保底偏低',
    }),
    expectFail('unauthorized'),
  );
  // 既往表态不受影响
  const view = service.householdView('H1', person('p2'));
  assert.equal(view.statements[0].status, 'active');
  assert.equal(view.grants[0].status, 'revoked');
});

test('委托范围：仅覆盖异议的授权不能用于表态；地块范围不覆盖的退出被拒', () => {
  const { service } = harness();
  seedVillage(service);

  // p2 只授予异议权
  service.dispatch({
    type: 'issue-grant', ctx: person('p2'),
    grantId: 'G3', householdId: 'H1', granterPersonId: 'p2', attorneyPersonId: 'p12',
    actions: ['objection'], expiresAt: '2026-04-01T00:00:00.000Z',
  });
  assert.throws(() => consent(service, 'P1', 'H1', 'p12'), expectFail('unauthorized'));
  // 异议本身可以
  const obj = service.dispatch({
    type: 'file-objection', ctx: person('p12'),
    proposalId: 'P1', householdId: 'H1', actorPersonId: 'p12',
    category: 'term', content: '退出条件需细化',
  });
  assert.ok(obj.ref);

  // 地块范围：p13 只被授权处理 L1，则不能替 H1 退出 L2
  service.dispatch({
    type: 'issue-grant', ctx: person('p2'),
    grantId: 'G4', householdId: 'H1', granterPersonId: 'p2', attorneyPersonId: 'p13',
    actions: ['plot_exit'], plotScope: ['L1'], expiresAt: '2026-04-01T00:00:00.000Z',
  });
  assert.throws(
    () => service.dispatch({
      type: 'file-plot-exit', ctx: person('p13'),
      proposalId: 'P1', plotId: 'L2', actorPersonId: 'p13',
    }),
    expectFail('unauthorized'),
  );
  // L1 在范围内，可以退出
  const exit = service.dispatch({
    type: 'file-plot-exit', ctx: person('p13'),
    proposalId: 'P1', plotId: 'L1', actorPersonId: 'p13',
  });
  assert.equal(exit.exited, true);
});

test('非本户成员且无授权，一律拒绝', () => {
  const { service } = harness();
  seedVillage(service);
  assert.throws(() => consent(service, 'P1', 'H1', 'p999'), expectFail('unauthorized'));
});

// ---------------------------------------------------------------------------
// 3. 企业改价：版本递增，旧表态不继承；并发改价确定
// ---------------------------------------------------------------------------

test('企业改价生成新版本，旧版本表态不计入新版本', () => {
  const { clock, service } = harness();
  seedVillage(service);

  consent(service, 'P1', 'H1', 'p1');
  consent(service, 'P1', 'H2', 'p3');

  const r = service.dispatch({
    type: 'revise-proposal', ctx: company('CO_A'),
    proposalId: 'P1', terms: baseTerms({ guaranteedIncome: { amount: 90, currency: 'CNY', period: 'mu/year' } }),
  });
  assert.equal(r.version, 2);

  const tally = service.groupTallyView('P1', COLLECTIVE);
  assert.equal(tally.version, 2);
  assert.equal(tally.consentCount, 0); // v1 的两票不继承到 v2
  assert.equal(tally.totalHouseholds, 6);
});

test('并发改价按到达顺序串行追加，版本号确定无缺号', async () => {
  const { service } = harness();
  seedVillage(service);

  const prices = [85, 90, 95, 100];
  const results = await Promise.all(
    prices.map((amount) => service.dispatch({
      type: 'revise-proposal', ctx: company('CO_A'),
      proposalId: 'P1', terms: baseTerms({ guaranteedIncome: { amount, currency: 'CNY', period: 'mu/year' } }),
    })),
  );
  const versions = results.map((r) => r.version).sort((a, b) => a - b);
  assert.deepEqual(versions, [2, 3, 4, 5]);

  const view = service.proposalView('P1', COLLECTIVE);
  assert.equal(view.versions.length, 5);
  // 各版本条款与版本一一对应，不串版
  for (const v of view.versions) {
    assert.ok(prices.concat([80]).includes(v.terms.guaranteedIncome.amount));
  }
});

test('并发表态与改价交错：表态绑定其到达时的当前版本，结果确定', async () => {
  const { service } = harness();
  seedVillage(service);

  await Promise.all([
    consent(service, 'P1', 'H1', 'p1'),
    service.dispatch({
      type: 'revise-proposal', ctx: company('CO_A'),
      proposalId: 'P1', terms: baseTerms({ areaMu: 100 }),
    }),
    consent(service, 'P1', 'H2', 'p3'),
  ]);

  // 必有一户落在 v1、一户落在 v2（按串行执行顺序），新版本上恰好一票
  const tally = service.groupTallyView('P1', COLLECTIVE);
  assert.equal(tally.version, 2);
  assert.equal(tally.consentCount, 1);

  const stmts = [...service.householdView('H1', COLLECTIVE).statements,
    ...service.householdView('H2', COLLECTIVE).statements];
  const versions = stmts.map((s) => s.version).sort();
  assert.deepEqual(versions, [1, 2]);
});

test('截止后企业不得改价', () => {
  const { clock, service } = harness();
  seedVillage(service);
  clock.setTo('2026-03-21T00:00:00.000Z');
  assert.throws(
    () => service.dispatch({
      type: 'revise-proposal', ctx: company('CO_A'),
      proposalId: 'P1', terms: baseTerms({ areaMu: 130 }),
    }),
    expectFail('deadline_passed'),
  );
});

test('他司不能修改提案', () => {
  const { service } = harness();
  seedVillage(service);
  assert.throws(
    () => service.dispatch({
      type: 'revise-proposal', ctx: company('CO_B'),
      proposalId: 'P1', terms: baseTerms(),
    }),
    expectFail('forbidden'),
  );
});

// ---------------------------------------------------------------------------
// 4. 少数地块退出：户仍保留资格，基数与公开范围一致
// ---------------------------------------------------------------------------

test('少数地块退出：地块剔除但该户仍参与；不能重复退出', () => {
  const { service } = harness();
  seedVillage(service);

  // H5 有 L6、L7，退出 L7
  service.dispatch({
    type: 'file-plot-exit', ctx: person('p8'),
    proposalId: 'P1', plotId: 'L7', actorPersonId: 'p8',
  });
  consent(service, 'P1', 'H5', 'p8');

  const view = service.proposalView('P1', COLLECTIVE);
  assert.equal(view.tally.livePlotCount, 8); // 9 - 1
  assert.equal(view.tally.totalHouseholds, 6); // H5 仍在
  assert.ok(view.exitedPlots.some((p) => p.plotId === 'L7'));

  assert.throws(
    () => service.dispatch({
      type: 'file-plot-exit', ctx: person('p8'),
      proposalId: 'P1', plotId: 'L7', actorPersonId: 'p8',
    }),
    expectFail('plot_already_exited'),
  );
});

test('地块全部退出后该户不再有参与资格', () => {
  const { service } = harness();
  seedVillage(service);
  // H3 只有 L4
  service.dispatch({
    type: 'file-plot-exit', ctx: person('p5'),
    proposalId: 'P1', plotId: 'L4', actorPersonId: 'p5',
  });
  assert.throws(() => consent(service, 'P1', 'H3', 'p5'), expectFail('household_not_eligible'));
  const tally = service.groupTallyView('P1', COLLECTIVE);
  assert.equal(tally.totalHouseholds, 5);
});

// ---------------------------------------------------------------------------
// 5. 重复表态：一户一票，最后到达为准
// ---------------------------------------------------------------------------

test('重复表态以最后一条为准，先同意后反对只计反对', async () => {
  const { service } = harness();
  seedVillage(service);

  await consent(service, 'P1', 'H1', 'p1');
  await service.dispatch({
    type: 'make-statement', ctx: person('p2'),
    proposalId: 'P1', householdId: 'H1', actorPersonId: 'p2', position: 'oppose',
  });
  // 同户两人几乎同时各自再表态
  await Promise.all([
    service.dispatch({
      type: 'make-statement', ctx: person('p1'),
      proposalId: 'P1', householdId: 'H1', actorPersonId: 'p1', position: 'oppose',
    }),
    service.dispatch({
      type: 'make-statement', ctx: person('p2'),
      proposalId: 'P1', householdId: 'H1', actorPersonId: 'p2', position: 'consent',
    }),
  ]);

  const tally = service.groupTallyView('P1', COLLECTIVE);
  assert.equal(tally.totalHouseholds, 6);
  // H1 至多贡献一票；同意户总数在 0/1 之间，绝不会被重复计成多票
  assert.ok(tally.consentCount <= 1);
  const sumByStatus = tally.groups.reduce(
    (n, g) => n + g.consentCount + g.opposeCount + g.pendingCount, 0,
  );
  assert.equal(sumByStatus, 6);
  // 各状态户号合计也必须恰好为 6（户号不重不漏）
  const ids = tally.groups.flatMap((g) => [...g.consented, ...g.opposed, ...g.pending]);
  assert.equal(ids.length, 6);
  assert.equal(new Set(ids).size, 6);

  const view = service.householdView('H1', COLLECTIVE);
  const active = view.statements.filter((s) => s.status === 'active' && s.version === 1);
  assert.equal(active.length, 1);
});

test('同一命令网络重放（幂等键）不产生第二条表态', () => {
  const { service } = harness();
  seedVillage(service);
  const cmd = {
    type: 'make-statement', ctx: person('p1'), idempotencyKey: 'idem-1',
    proposalId: 'P1', householdId: 'H1', actorPersonId: 'p1', position: 'consent',
  };
  const a = service.dispatch(cmd);
  const b = service.dispatch(cmd);
  assert.equal(a.ref, b.ref);
  const view = service.householdView('H1', COLLECTIVE);
  assert.equal(view.statements.filter((s) => s.status === 'active').length, 1);
});

// ---------------------------------------------------------------------------
// 6. 截止前撤回；撤回后可重新表态；截止后不能撤回
// ---------------------------------------------------------------------------

test('截止前撤回表态后该户回到待定，可再次表态', () => {
  const { service } = harness();
  seedVillage(service);
  consent(service, 'P1', 'H1', 'p1');
  assert.equal(service.groupTallyView('P1', COLLECTIVE).consentCount, 1);

  service.dispatch({
    type: 'withdraw-statement', ctx: person('p1'),
    proposalId: 'P1', householdId: 'H1', actorPersonId: 'p1',
  });
  assert.equal(service.groupTallyView('P1', COLLECTIVE).consentCount, 0);

  consent(service, 'P1', 'H1', 'p1');
  assert.equal(service.groupTallyView('P1', COLLECTIVE).consentCount, 1);
});

test('截止后撤回被拒；无有效表态时撤回得到确定错误', () => {
  const { clock, service } = harness();
  seedVillage(service);
  consent(service, 'P1', 'H1', 'p1');
  clock.setTo('2026-03-21T00:00:00.000Z');
  assert.throws(
    () => service.dispatch({
      type: 'withdraw-statement', ctx: person('p1'),
      proposalId: 'P1', householdId: 'H1', actorPersonId: 'p1',
    }),
    expectFail('deadline_passed'),
  );

  const { clock: c2, service: s2 } = harness();
  seedVillage(s2);
  assert.throws(
    () => s2.dispatch({
      type: 'withdraw-statement', ctx: person('p1'),
      proposalId: 'P1', householdId: 'H1', actorPersonId: 'p1',
    }),
    expectFail('statement_not_found'),
  );
});

// ---------------------------------------------------------------------------
// 7. 法定比例：达不到不能进入签署
// ---------------------------------------------------------------------------

test('同意比例不足时定稿被拒，并在错误中给出确定票数', () => {
  const { clock, service } = harness();
  seedVillage(service, { threshold: 2 / 3 });
  // 仅 3/6 同意 = 1/2
  consent(service, 'P1', 'H1', 'p1');
  consent(service, 'P1', 'H2', 'p3');
  consent(service, 'P1', 'H3', 'p5');
  clock.setTo('2026-03-21T00:00:00.000Z');
  try {
    service.dispatch({ type: 'finalize-proposal', ctx: COLLECTIVE, proposalId: 'P1' });
    assert.fail('应当拒绝定稿');
  } catch (error) {
    assert.equal(error.code, 'quorum_not_met');
    assert.deepEqual(error.details, { threshold: 2 / 3, consentCount: 3, totalHouseholds: 6 });
  }
});

test('截止前不得定稿；定稿后文本锁定不可再改价/表态', () => {
  const { clock, service } = harness();
  seedVillage(service);
  for (const [h, p] of [['H1', 'p1'], ['H2', 'p3'], ['H3', 'p5'], ['H4', 'p6']]) {
    consent(service, 'P1', h, p);
  }
  assert.throws(
    () => service.dispatch({ type: 'finalize-proposal', ctx: COLLECTIVE, proposalId: 'P1' }),
    expectFail('deadline_not_reached'),
  );

  clock.setTo('2026-03-21T00:00:00.000Z');
  service.dispatch({ type: 'finalize-proposal', ctx: COLLECTIVE, proposalId: 'P1' });

  assert.throws(
    () => service.dispatch({
      type: 'revise-proposal', ctx: company('CO_A'),
      proposalId: 'P1', terms: baseTerms({ areaMu: 200 }),
    }),
    expectFail('proposal_locked'),
  );
  assert.throws(() => consent(service, 'P1', 'H5', 'p8'), expectFail('proposal_locked'));
});

// ---------------------------------------------------------------------------
// 8. 异议留痕：版本绑定、截止后标记、事件可审计
// ---------------------------------------------------------------------------

test('异议绑定版本并完整留痕，截止后异议被标记但仍受理', () => {
  const { clock, service } = harness();
  seedVillage(service);

  service.dispatch({
    type: 'file-objection', ctx: person('p1'),
    proposalId: 'P1', householdId: 'H1', actorPersonId: 'p1',
    category: 'price', content: 'v1 保底收益偏低',
  });
  service.dispatch({
    type: 'revise-proposal', ctx: company('CO_A'),
    proposalId: 'P1', terms: baseTerms({ guaranteedIncome: { amount: 90, currency: 'CNY', period: 'mu/year' } }),
  });
  service.dispatch({
    type: 'file-objection', ctx: person('p1'),
    proposalId: 'P1', householdId: 'H1', actorPersonId: 'p1',
    category: 'term', content: 'v2 退出条件不清',
  });
  clock.setTo('2026-03-21T00:00:00.000Z');
  service.dispatch({
    type: 'file-objection', ctx: person('p1'),
    proposalId: 'P1', householdId: 'H1', actorPersonId: 'p1',
    category: 'procedure', content: '截止后补充程序异议',
  });

  const ledger = service.objectionsView('P1', COLLECTIVE);
  assert.equal(ledger.items.length, 3);
  assert.equal(ledger.items[0].version, 1);
  assert.equal(ledger.items[1].version, 2);
  assert.equal(ledger.items[2].version, 2);
  assert.equal(ledger.items[2].afterDeadline, true);
  assert.equal(ledger.items[0].afterDeadline, false);

  // 事件日志可完整重放，seq 连续
  const { events } = service.eventLog(COLLECTIVE);
  for (let i = 0; i < events.length; i += 1) assert.equal(events[i].seq, i + 1);
});

// ---------------------------------------------------------------------------
// 9. 脱敏：汇总绝不暴露无权查看的家庭资料
// ---------------------------------------------------------------------------

test('公司视图：只见分组计数，不见任何户号/成员/异议内容', () => {
  const { service } = harness();
  seedVillage(service);
  consent(service, 'P1', 'H1', 'p1');
  service.dispatch({
    type: 'file-objection', ctx: person('p1'),
    proposalId: 'P1', householdId: 'H1', actorPersonId: 'p1',
    category: 'price', content: '家庭敏感诉求内容',
  });

  const pub = service.groupTallyView('P1', company('CO_A'));
  const serialized = JSON.stringify(pub);
  for (const leaked of ['H1', 'p1', '某']) assert.ok(!serialized.includes(leaked), `不应泄露：${leaked}`);
  for (const g of pub.groups) {
    assert.equal(g.consented, undefined);
    assert.equal(g.opposed, undefined);
  }

  const proposal = service.proposalView('P1', company('CO_A'));
  assert.equal(proposal.tally.consented, undefined);
  assert.equal(proposal.exitedPlots, undefined);

  const objections = service.objectionsView('P1', company('CO_A'));
  assert.equal(objections.items, undefined);
  assert.equal(objections.byCategory.price, 1);
});

test('公开视图无家庭标识；公司不能看家庭明细与他司数据', () => {
  const { service } = harness();
  seedVillage(service);
  consent(service, 'P1', 'H1', 'p1');

  const pub = service.groupTallyView('P1', { role: 'public' });
  assert.ok(!JSON.stringify(pub).includes('H1'));

  assert.throws(() => service.householdView('H1', company('CO_A')), expectFail('forbidden'));
  assert.throws(() => service.householdView('H1', { role: 'public' }), expectFail('forbidden'));
  assert.throws(() => service.objectionsView('P1', { role: 'public' }), expectFail('forbidden'));
  assert.throws(() => service.proposalView('P1', company('CO_OTHER')), expectFail('forbidden'));
  assert.throws(() => service.eventLog(company('CO_A')), expectFail('forbidden'));
});

test('家庭成员只能看本户，不能看他户', () => {
  const { service } = harness();
  seedVillage(service);
  assert.ok(service.householdView('H1', person('p2')).householdId === 'H1');
  assert.throws(() => service.householdView('H2', person('p2')), expectFail('forbidden'));
});

// ---------------------------------------------------------------------------
// 10. 委托只覆盖指定地块的退出 + 退出后定稿范围剔除
// ---------------------------------------------------------------------------

test('定稿快照只含在范围地块，退出地块不进入最终文本', () => {
  const { clock, service } = harness();
  seedVillage(service);
  // H6 退出 L9（保留 L8）
  service.dispatch({
    type: 'file-plot-exit', ctx: person('p9'),
    proposalId: 'P1', plotId: 'L9', actorPersonId: 'p9',
  });
  for (const [h, p] of [['H1', 'p1'], ['H2', 'p3'], ['H3', 'p5'], ['H4', 'p6'], ['H5', 'p8'], ['H6', 'p9']]) {
    consent(service, 'P1', h, p);
  }
  clock.setTo('2026-03-21T00:00:00.000Z');
  const fin = service.dispatch({ type: 'finalize-proposal', ctx: COLLECTIVE, proposalId: 'P1' });
  assert.equal(fin.totalHouseholds, 6);
  const collective = service.proposalView('P1', COLLECTIVE);
  assert.deepEqual(collective.finalized.scopePlotIds.sort(), ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8']);
  const pub = service.proposalView('P1', { role: 'public' });
  assert.equal(pub.finalized.scopePlotIds, undefined);
});
