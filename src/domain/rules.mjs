/**
 * 参与、授权与文本版本判定的纯规则。
 * 全部输入显式给出（state/clock），不依赖单例外的状态，便于并发测试。
 */
import { fail } from './errors.mjs';

export const ACTIONS = Object.freeze({
  STATEMENT: 'statement',
  OBJECTION: 'objection',
  PLOT_EXIT: 'plot_exit',
});

/** 该地块是否仍在提案范围内（少数地块退出后即剔除）。 */
export function plotInScope(state, proposal, plotId, at) {
  if (!proposal.scopePlotIds.includes(plotId)) return false;
  const plot = state.plots.get(plotId);
  if (!plot) return false;
  if (plot.exit && plot.exit.at <= at) return false;
  return true;
}

/**
 * 找到 actor 在 at 时刻可以代表 household 行事、且覆盖 action/plot 的有效授权。
 * 本人（户主本人）直接通过；其余必须有 active、未过期、动作与地块范围均覆盖的授权。
 * 返回 { grantId } 或抛 DomainError。
 */
export function resolveAuthority(state, { householdId, actorPersonId, action, plotId = null, at }) {
  const household = state.households.get(householdId);
  if (!household) fail('household_not_found', '家庭不存在', { status: 404 });

  // 家庭成员本人且属于该户：对本户事务自有处分权
  const self = household.members.get(actorPersonId);
  if (self) {
    // 但“代表外地家庭成员”的远程委托仍需授权：本人只能代表自己。
    // 表态以户为单位，任一户内成员本人作出即视为该户真实意思。
    return { grantId: null };
  }

  // 非本户成员：必须持有效授权
  const valid = [...state.grants.values()]
    .filter(
      (g) =>
        g.householdId === householdId &&
        g.attorneyPersonId === actorPersonId &&
        g.status === 'active' &&
        g.issuedAt <= at &&
        g.expiresAt > at &&
        g.actions.has(action),
    )
    // 地块范围：null 表示全户范围；否则要求覆盖
    .filter((g) => g.plotScope === null || (plotId !== null && g.plotScope.includes(plotId)));

  if (valid.length === 0) {
    fail('unauthorized', '无有效授权：委托不存在、已撤销、已过期或范围不覆盖该动作/地块', {
      status: 403,
      details: { householdId, actorPersonId, action, plotId, at },
    });
  }
  // 同一受托人可能有多份授权，取最晚签发的一份，结果确定
  valid.sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1));
  return { grantId: valid[0].id };
}

/**
 * 某户在指定版本上的“当前有效表态”。
 * 规则：
 *  - 只计 active；被新版本表态替换或已撤回的不计；
 *  - 表态必须针对该版本；企业改价后旧版本表态不再计入新版本；
 *  - 以户为单位，一户一票（同户多人表态时，取 seq 最大的一条，即“最后表态”，杜绝重复表态）。
 */
export function effectiveStatementFor(state, proposal, version, householdId, at = null) {
  const candidates = [...state.statements.values()].filter(
    (s) =>
      s.proposalId === proposal.id &&
      s.version === version &&
      s.householdId === householdId &&
      s.status === 'active' &&
      (at === null || s.at <= at),
  );
  if (candidates.length === 0) return null;
  // seq 是事件追加顺序的唯一裁决依据（同刻到达也有确定先后）
  candidates.sort((a, b) => b.seq - a.seq);
  return candidates[0];
}

/**
 * 法定参与/通过条件计算。
 * 基数：提案当前范围内（扣除已退出地块）涉及的、至少有一块在范围内地块的户。
 * 计票：当前版本上有有效“同意”表态的户 / 基数户。
 */
export function participationTally(state, proposal, at) {
  const eligibleHouseholdIds = new Set();
  const livePlotIds = [];
  for (const plotId of proposal.scopePlotIds) {
    if (plotInScope(state, proposal, plotId, at)) {
      livePlotIds.push(plotId);
      const plot = state.plots.get(plotId);
      if (plot) eligibleHouseholdIds.add(plot.householdId);
    }
  }

  const currentVersion = proposal.versions[proposal.versions.length - 1]?.version ?? null;

  const consented = [];
  const opposed = [];
  const pending = [];
  for (const householdId of eligibleHouseholdIds) {
    const s = effectiveStatementFor(state, proposal, currentVersion, householdId, at);
    if (!s) pending.push(householdId);
    else if (s.position === 'consent') consented.push(householdId);
    else if (s.position === 'oppose') opposed.push(householdId);
  }

  const total = eligibleHouseholdIds.size;
  const consentCount = consented.length;
  const threshold = proposal.threshold; // 0..1
  const quorumReached = total > 0 && consentCount / total >= threshold;

  return {
    at,
    version: currentVersion,
    totalHouseholds: total,
    livePlotIds,
    consented,
    opposed,
    pending,
    consentCount,
    threshold,
    quorumReached,
    deadline: proposal.deadline,
    afterDeadline: at > proposal.deadline,
  };
}
