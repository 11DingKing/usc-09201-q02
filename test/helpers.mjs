/**
 * 测试装配：手动时钟 + 内存存储 + 直接派发命令。
 */
import { ManualClock } from '../src/domain/clock.mjs';
import { EventStore } from '../src/domain/store.mjs';
import { NegotiationService } from '../src/domain/service.mjs';

export function harness(initialTime = '2026-03-01T08:00:00.000Z') {
  const clock = new ManualClock(initialTime);
  const store = new EventStore();
  const service = new NegotiationService(store, clock);
  return { clock, store, service };
}

export const COLLECTIVE = { role: 'collective' };
export const company = (companyId) => ({ role: 'company', companyId });
export const person = (personId) => ({ role: 'person', personId });

export const baseTerms = (overrides = {}) => ({
  areaMu: 120,
  leaseYears: 15,
  guaranteedIncome: { amount: 80, currency: 'CNY', period: 'mu/year' },
  exitConditions: ['征用补偿按面积比例分配', '连续两年未付租金可解除'],
  ...overrides,
});

/** 登记跨两个村民小组的 6 户、9 块地。 */
export function seedVillage(service, { proposalId = 'P1', companyId = 'CO_A', deadline = '2026-03-20T00:00:00.000Z', threshold } = {}) {
  service.dispatch({ type: 'register-company', ctx: COLLECTIVE, companyId, name: '青山林下公司' });

  // 甲组 H1-H3，乙组 H4-H6
  const defs = [
    ['H1', '甲组', [['p1', 'head'], ['p2', 'member']]],
    ['H2', '甲组', [['p3', 'head'], ['p4', 'member']]],
    ['H3', '甲组', [['p5', 'head']]],
    ['H4', '乙组', [['p6', 'head'], ['p7', 'member']]],
    ['H5', '乙组', [['p8', 'head']]],
    ['H6', '乙组', [['p9', 'head'], ['p10', 'member']]],
  ];
  for (const [hid, group, members] of defs) {
    service.dispatch({
      type: 'register-household', ctx: COLLECTIVE,
      householdId: hid, name: `${hid}号户`, group,
      members: members.map(([personId, role]) => ({ personId, name: `${personId}某`, role })),
    });
  }
  const plots = [
    ['L1', 'H1', '甲组'], ['L2', 'H1', '甲组'],
    ['L3', 'H2', '甲组'],
    ['L4', 'H3', '甲组'],
    ['L5', 'H4', '乙组'],
    ['L6', 'H5', '乙组'], ['L7', 'H5', '乙组'],
    ['L8', 'H6', '乙组'], ['L9', 'H6', '乙组'],
  ];
  for (const [plotId, householdId, group] of plots) {
    service.dispatch({ type: 'register-plot', ctx: COLLECTIVE, plotId, householdId, group });
  }
  service.dispatch({
    type: 'create-proposal',
    ctx: company(companyId),
    proposalId,
    scopePlotIds: plots.map(([pid]) => pid),
    deadline,
    ...(threshold ? { threshold } : {}),
    terms: baseTerms(),
  });
  return { plots: plots.map(([pid]) => pid) };
}

export function consent(service, proposalId, householdId, actorPersonId, extra = {}) {
  return service.dispatch({
    type: 'make-statement', ctx: person(actorPersonId),
    proposalId, householdId, actorPersonId, position: 'consent', ...extra,
  });
}
