/**
 * 应用服务：命令校验 -> 追加事件；查询 -> 投影 + 按角色脱敏。
 *
 * 并发模型：Node 单线程 + 单一写入队列。所有命令按“进入队列的顺序”串行执行，
 * 每条命令看到的都是包含此前全部命令的状态，因此并发改价、并发表态、
 * 撤回与表态交错的结果只取决于到达顺序，确定可复现。
 */
import { DomainError, fail } from './errors.mjs';
import { reduce } from './models.mjs';
import { ACTIONS, participationTally, plotInScope, resolveAuthority } from './rules.mjs';

let counter = 0;
function id(prefix) {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

const TERM_FIELDS = ['areaMu', 'leaseYears', 'guaranteedIncome', 'exitConditions'];

export class NegotiationService {
  constructor(store, clock) {
    this.store = store;
    this.clock = clock;
    // 幂等键 -> 首次调用结果（命令重放返回同一结果，网络重试不会产生双份表态/异议）
    this.idempotency = new Map();
  }

  /**
   * 派发命令。execute 为纯同步执行（校验 + 追加事件），在 Node 单线程下原子完成，
   * 不会与其他命令交错；并发请求按各自 body 读取完成后进入本方法的先后顺序定序，
   * 因此并发改价/表态/撤回的结果只取决于到达顺序，确定可复现。
   */
  dispatch(command) {
    return this.#handle(command);
  }

  #state() {
    return reduce(this.store.events);
  }

  #handle(command) {
    if (command.idempotencyKey) {
      const seen = this.idempotency.get(command.idempotencyKey);
      if (seen) {
        if (seen.__error) throw new DomainError(seen.__error.code, seen.__error.message, {
          status: seen.__error.status,
          details: seen.__error.details,
        });
        return structuredClone(seen);
      }
    }
    try {
      const outcome = this.execute(command);
      if (command.idempotencyKey) {
        this.idempotency.set(command.idempotencyKey, structuredClone(outcome));
      }
      return outcome;
    } catch (error) {
      if (command.idempotencyKey && error instanceof DomainError) {
        const recorded = { __error: { code: error.code, message: error.message, details: error.details, status: error.status } };
        this.idempotency.set(command.idempotencyKey, recorded);
      }
      throw error;
    }
  }

  execute(command) {
    const at = this.clock.nowISO();
    const state = this.#state();
    switch (command.type) {
      case 'register-company':
        return this.#registerCompany(state, at, command);
      case 'register-household':
        return this.#registerHousehold(state, at, command);
      case 'register-plot':
        return this.#registerPlot(state, at, command);
      case 'create-proposal':
        return this.#createProposal(state, at, command);
      case 'revise-proposal':
        return this.#reviseProposal(state, at, command);
      case 'extend-deadline':
        return this.#extendDeadline(state, at, command);
      case 'issue-grant':
        return this.#issueGrant(state, at, command);
      case 'revoke-grant':
        return this.#revokeGrant(state, at, command);
      case 'file-plot-exit':
        return this.#filePlotExit(state, at, command);
      case 'make-statement':
        return this.#makeStatement(state, at, command);
      case 'withdraw-statement':
        return this.#withdrawStatement(state, at, command);
      case 'file-objection':
        return this.#fileObjection(state, at, command);
      case 'finalize-proposal':
        return this.#finalizeProposal(state, at, command);
      default:
        fail('unknown_command', `未知命令：${command.type}`, { status: 400 });
    }
  }

  // ---------- 基础登记 ----------

  #requireCollective(command) {
    if (command.ctx?.role !== 'collective') {
      fail('forbidden', '仅村集体可执行该操作', { status: 403 });
    }
  }

  #registerCompany(state, at, c) {
    this.#requireCollective(c);
    if (state.companies.has(c.companyId)) fail('id_conflict', '公司已登记', { status: 409 });
    if (!c.companyId || !c.name) fail('invalid_argument', 'companyId 与 name 必填');
    const ev = this.store.append(at, 'company-registered', { companyId: c.companyId, name: c.name });
    return { ref: ev.data.companyId };
  }

  #registerHousehold(state, at, c) {
    this.#requireCollective(c);
    if (state.households.has(c.householdId)) fail('id_conflict', '该户已登记', { status: 409 });
    if (!Array.isArray(c.members) || c.members.length === 0) {
      fail('invalid_argument', '至少登记一名家庭成员');
    }
    const personIds = new Set();
    for (const m of c.members) {
      if (!m.personId || !m.name) fail('invalid_argument', '成员 personId/name 必填');
      if (personIds.has(m.personId)) fail('invalid_argument', '成员 personId 重复');
      personIds.add(m.personId);
    }
    const ev = this.store.append(at, 'household-registered', {
      householdId: c.householdId,
      name: c.name,
      group: c.group,
      members: c.members.map((m) => ({ personId: m.personId, name: m.name, role: m.role ?? 'member' })),
    });
    return { ref: ev.data.householdId };
  }

  #registerPlot(state, at, c) {
    this.#requireCollective(c);
    if (state.plots.has(c.plotId)) fail('id_conflict', '该地块已登记', { status: 409 });
    const household = state.households.get(c.householdId);
    if (!household) fail('household_not_found', '家庭不存在', { status: 404 });
    const ev = this.store.append(at, 'plot-registered', {
      plotId: c.plotId,
      householdId: c.householdId,
      group: c.group ?? household.group,
    });
    return { ref: ev.data.plotId };
  }

  // ---------- 提案与文本版本 ----------

  #getOpenProposal(state, proposalId) {
    const p = state.proposals.get(proposalId);
    if (!p) fail('proposal_not_found', '提案不存在', { status: 404 });
    if (p.status !== 'open') fail('proposal_locked', '提案已定稿，不可再修改', { status: 409 });
    return p;
  }

  #requireCompany(state, c) {
    if (c.ctx?.role !== 'company' || !c.ctx?.companyId) {
      fail('forbidden', '仅项目公司可执行该操作', { status: 403 });
    }
    return c.ctx.companyId;
  }

  #validateTerms(terms) {
    if (!terms || typeof terms !== 'object') fail('invalid_argument', '条款必须为对象');
    for (const field of TERM_FIELDS) {
      if (!(field in terms)) fail('invalid_argument', `条款缺少字段：${field}`);
    }
    if (!(terms.areaMu > 0)) fail('invalid_argument', '面积必须为正数');
    if (!(terms.leaseYears > 0)) fail('invalid_argument', '租期必须为正数');
    if (typeof terms.guaranteedIncome !== 'object' || terms.guaranteedIncome === null) {
      fail('invalid_argument', '保底收益需为 {amount,currency,period} 对象');
    }
    if (!Array.isArray(terms.exitConditions) || terms.exitConditions.length === 0) {
      fail('invalid_argument', '退出条件至少一条');
    }
  }

  #createProposal(state, at, c) {
    const companyId = this.#requireCompany(state, c);
    if (state.proposals.has(c.proposalId)) fail('id_conflict', '提案标识已存在', { status: 409 });
    if (!Array.isArray(c.scopePlotIds) || c.scopePlotIds.length === 0) {
      fail('invalid_argument', '提案至少包含一块地');
    }
    const scope = [...new Set(c.scopePlotIds)];
    for (const plotId of scope) {
      if (!state.plots.has(plotId)) fail('plot_not_found', `地块不存在：${plotId}`, { status: 404 });
    }
    const threshold = c.threshold ?? 2 / 3;
    if (!(threshold > 0 && threshold <= 1)) fail('invalid_argument', '法定比例须在 (0,1]');
    if (!c.deadline || Date.parse(c.deadline) <= Date.parse(at)) {
      fail('invalid_argument', '截止时间必须晚于当前时间');
    }
    this.#validateTerms(c.terms);

    let ev = this.store.append(at, 'proposal-created', {
      proposalId: c.proposalId,
      companyId,
      scopePlotIds: scope,
      threshold,
      deadline: c.deadline,
    });
    ev = this.store.append(at, 'proposal-revised', {
      proposalId: c.proposalId,
      version: 1,
      terms: c.terms,
    });
    return { ref: c.proposalId, version: 1, seq: ev.seq };
  }

  #reviseProposal(state, at, c) {
    const companyId = this.#requireCompany(state, c);
    const p = this.#getOpenProposal(state, c.proposalId);
    if (p.companyId !== companyId) fail('forbidden', '只能修改本公司提案', { status: 403 });
    if (at > p.deadline) fail('deadline_passed', '协商已截止，企业不得再改价', { status: 409 });
    this.#validateTerms(c.terms);
    const version = p.versions.length + 1;
    const ev = this.store.append(at, 'proposal-revised', {
      proposalId: c.proposalId,
      version,
      terms: c.terms,
    });
    return { ref: c.proposalId, version, seq: ev.seq };
  }

  #extendDeadline(state, at, c) {
    const companyId = this.#requireCompany(state, c);
    const p = this.#getOpenProposal(state, c.proposalId);
    if (p.companyId !== companyId) fail('forbidden', '只能调整本公司提案', { status: 403 });
    if (at > p.deadline) fail('deadline_passed', '已过截止时间，不能顺延', { status: 409 });
    if (!c.newDeadline || Date.parse(c.newDeadline) <= Date.parse(p.deadline)) {
      fail('invalid_argument', '新截止时间必须晚于原截止时间');
    }
    this.store.append(at, 'proposal-deadline-extended', {
      proposalId: c.proposalId,
      newDeadline: c.newDeadline,
    });
    return { ref: c.proposalId, deadline: c.newDeadline };
  }

  // ---------- 授权委托 ----------

  #issueGrant(state, at, c) {
    // 远程委托由成员本人作出；村集体可代为登记（备案）
    const actor = c.ctx;
    if (actor?.role !== 'collective' && !(actor?.role === 'person' && actor.personId === c.granterPersonId)) {
      fail('forbidden', '仅成员本人或村集体可登记委托', { status: 403 });
    }
    const household = state.households.get(c.householdId);
    if (!household) fail('household_not_found', '家庭不存在', { status: 404 });
    if (!household.members.has(c.granterPersonId)) {
      fail('invalid_argument', '委托人必须是该户家庭成员');
    }
    if (!c.attorneyPersonId) fail('invalid_argument', '受托人必填');
    if (state.grants.has(c.grantId)) fail('id_conflict', '委托编号已存在', { status: 409 });
    const actions = c.actions ?? [ACTIONS.STATEMENT, ACTIONS.OBJECTION];
    for (const a of actions) {
      if (!Object.values(ACTIONS).includes(a)) fail('invalid_argument', `未知授权动作：${a}`);
    }
    if (!c.expiresAt || Date.parse(c.expiresAt) <= Date.parse(at)) {
      fail('invalid_argument', '委托到期时间必须晚于当前时间');
    }
    let plotScope = null;
    if (c.plotScope) {
      plotScope = [...new Set(c.plotScope)];
      for (const plotId of plotScope) {
        const plot = state.plots.get(plotId);
        if (!plot || plot.householdId !== c.householdId) {
          fail('invalid_argument', `地块不属于该户：${plotId}`);
        }
      }
    }
    const ev = this.store.append(at, 'grant-issued', {
      grantId: c.grantId,
      householdId: c.householdId,
      granterPersonId: c.granterPersonId,
      attorneyPersonId: c.attorneyPersonId,
      actions,
      plotScope,
      expiresAt: c.expiresAt,
    });
    return { ref: ev.data.grantId };
  }

  #revokeGrant(state, at, c) {
    const g = state.grants.get(c.grantId);
    if (!g) fail('grant_not_found', '委托不存在', { status: 404 });
    const actor = c.ctx;
    if (actor?.role !== 'collective' && !(actor?.role === 'person' && actor.personId === g.granterPersonId)) {
      fail('forbidden', '仅委托人本人或村集体可撤销委托', { status: 403 });
    }
    if (g.status !== 'active') return { ref: g.id, alreadyRevoked: true };
    this.store.append(at, 'grant-revoked', { grantId: c.grantId, reason: c.reason ?? null });
    return { ref: c.grantId, revoked: true };
    // 注意：撤销只对“之后”的动作生效，此前已作出的表态/异议保持有效。
  }

  // ---------- 地块退出 ----------

  #filePlotExit(state, at, c) {
    const p = this.#getOpenProposal(state, c.proposalId);
    if (at > p.deadline) fail('deadline_passed', '协商截止后不得再退出地块', { status: 409 });
    if (!p.scopePlotIds.includes(c.plotId)) fail('plot_not_in_scope', '该地块不在提案范围内', { status: 404 });
    const plot = state.plots.get(c.plotId);
    if (!plot) fail('plot_not_found', '地块不存在', { status: 404 });
    if (!plotInScope(state, p, c.plotId, at)) {
      fail('plot_already_exited', '该地块已退出，不能重复退出', { status: 409 });
    }
    const { grantId } = resolveAuthority(state, {
      householdId: plot.householdId,
      actorPersonId: c.actorPersonId,
      action: ACTIONS.PLOT_EXIT,
      plotId: c.plotId,
      at,
    });
    const ev = this.store.append(at, 'plot-exit-filed', {
      proposalId: c.proposalId,
      plotId: c.plotId,
      householdId: plot.householdId,
      personId: c.actorPersonId,
      viaGrantId: grantId,
      fromVersion: p.versions[p.versions.length - 1].version,
      reason: c.reason ?? null,
    });
    return { ref: ev.data.plotId, exited: true };
  }

  // ---------- 表态 ----------

  #makeStatement(state, at, c) {
    const p = this.#getOpenProposal(state, c.proposalId);
    if (at > p.deadline) fail('deadline_passed', '协商已截止，不能再表态', { status: 409 });
    if (!['consent', 'oppose'].includes(c.position)) {
      fail('invalid_argument', '表态只能是 consent 或 oppose');
    }
    const household = state.households.get(c.householdId);
    if (!household) fail('household_not_found', '家庭不存在', { status: 404 });
    const hasLivePlot = p.scopePlotIds.some(
      (plotId) => state.plots.get(plotId)?.householdId === c.householdId && plotInScope(state, p, plotId, at),
    );
    if (!hasLivePlot) fail('household_not_eligible', '该户在提案当前范围内已无地块', { status: 409 });

    const { grantId } = resolveAuthority(state, {
      householdId: c.householdId,
      actorPersonId: c.actorPersonId,
      action: ACTIONS.STATEMENT,
      at,
    });

    const version = p.versions[p.versions.length - 1].version;

    // 重复表态：找出该户在当前版本上的有效表态，原样标记为 replaced。
    // 无论同一动作被重放/并发多少次，最终有效表态恒为“最后到达的一条”。
    const previous = [...state.statements.values()]
      .filter((s) => s.proposalId === p.id && s.version === version && s.householdId === c.householdId && s.status === 'active')
      .sort((a, b) => b.seq - a.seq)[0];

    const statementId = c.statementId ?? id('stmt');
    this.store.append(at, 'statement-made', {
      statementId,
      proposalId: p.id,
      version,
      householdId: c.householdId,
      personId: c.actorPersonId,
      viaGrantId: grantId,
      position: c.position,
    });
    if (previous) {
      this.store.append(at, 'statement-replaced', {
        previousStatementId: previous.id,
        statementId,
      });
    }
    return { ref: statementId, version, replaced: previous?.id ?? null };
  }

  #withdrawStatement(state, at, c) {
    const p = state.proposals.get(c.proposalId);
    if (!p) fail('proposal_not_found', '提案不存在', { status: 404 });
    if (p.status !== 'open') fail('proposal_locked', '提案已定稿', { status: 409 });
    if (at > p.deadline) fail('deadline_passed', '截止后不得撤回表态', { status: 409 });

    const version = p.versions[p.versions.length - 1].version;
    const active = [...state.statements.values()]
      .filter(
        (s) => s.proposalId === p.id && s.version === version && s.householdId === c.householdId && s.status === 'active',
      )
      .sort((a, b) => b.seq - a.seq)[0];
    if (!active) fail('statement_not_found', '该户当前版本上没有可撤回的有效表态', { status: 404 });

    // 撤回同样要校验行为人的现时授权
    resolveAuthority(state, {
      householdId: c.householdId,
      actorPersonId: c.actorPersonId,
      action: ACTIONS.STATEMENT,
      at,
    });

    this.store.append(at, 'statement-withdrawn', {
      statementId: active.id,
      personId: c.actorPersonId,
      reason: c.reason ?? null,
    });
    return { ref: active.id, withdrawn: true };
  }

  // ---------- 异议 ----------

  #fileObjection(state, at, c) {
    const p = state.proposals.get(c.proposalId);
    if (!p) fail('proposal_not_found', '提案不存在', { status: 404 });
    if (p.status !== 'open') fail('proposal_locked', '提案已定稿，不能再登记异议', { status: 409 });
    if (!c.category || !c.content) fail('invalid_argument', '异议类别与内容必填');

    const { grantId } = resolveAuthority(state, {
      householdId: c.householdId,
      actorPersonId: c.actorPersonId,
      action: ACTIONS.OBJECTION,
      at,
    });
    const version = p.versions[p.versions.length - 1].version;
    const objectionId = c.objectionId ?? id('obj');
    const ev = this.store.append(at, 'objection-filed', {
      objectionId,
      proposalId: p.id,
      version,
      householdId: c.householdId,
      personId: c.actorPersonId,
      viaGrantId: grantId,
      category: c.category,
      content: c.content,
      afterDeadline: at > p.deadline,
    });
    return { ref: objectionId, version };
  }

  // ---------- 定稿 ----------

  #finalizeProposal(state, at, c) {
    this.#requireCollective(c);
    const p = state.proposals.get(c.proposalId);
    if (!p) fail('proposal_not_found', '提案不存在', { status: 404 });
    if (p.status === 'finalized') fail('proposal_locked', '提案已定稿', { status: 409 });
    if (at <= p.deadline) fail('deadline_not_reached', '尚未到协商截止时间，不能定稿', { status: 409 });

    const tally = participationTally(state, p, at);
    if (!tally.quorumReached) {
      fail('quorum_not_met', '未达到法定参与（同意）比例，不能进入签署', {
        status: 409,
        details: {
          threshold: tally.threshold,
          consentCount: tally.consentCount,
          totalHouseholds: tally.totalHouseholds,
        },
      });
    }

    const version = tally.version;
    const terms = p.versions.find((v) => v.version === version).terms;
    // 最终文本是当前版本条款的不可变快照
    const textRef = c.textRef ?? `${p.id}/text/v${version}`;
    this.store.append(at, 'proposal-finalized', {
      proposalId: p.id,
      version,
      terms,
      scopePlotIds: tally.livePlotIds,
      consentCount: tally.consentCount,
      totalHouseholds: tally.totalHouseholds,
      unresolvedObjectionCount: [...state.objections.values()].filter(
        (o) => o.proposalId === p.id && o.version === version,
      ).length,
      textRef,
    });
    return {
      ref: p.id,
      version,
      textRef,
      consentCount: tally.consentCount,
      totalHouseholds: tally.totalHouseholds,
    };
  }

  // ============ 查询视图（按角色脱敏） ============

  #proposalOrThrow(state, proposalId) {
    const p = state.proposals.get(proposalId);
    if (!p) fail('proposal_not_found', '提案不存在', { status: 404 });
    return p;
  }

  /** 提案总览：集体全量；公司只见统计；公开只见统计与文本，不含任何家庭标识。 */
  proposalView(proposalId, ctx = { role: 'public' }) {
    const state = this.#state();
    const p = this.#proposalOrThrow(state, proposalId);
    const at = this.clock.nowISO();
    const tally = participationTally(state, p, at);

    const base = {
      proposalId: p.id,
      companyId: p.companyId,
      status: p.status,
      deadline: p.deadline,
      threshold: p.threshold,
      currentVersion: tally.version,
      versions: p.versions.map((v) => ({
        version: v.version,
        terms: v.terms,
        publishedAt: v.publishedAt,
      })),
      tally: {
        totalHouseholds: tally.totalHouseholds,
        consentCount: tally.consentCount,
        opposeCount: tally.opposed.length,
        pendingCount: tally.pending.length,
        quorumReached: tally.quorumReached,
        livePlotCount: tally.livePlotIds.length,
      },
      objectionCount: [...state.objections.values()].filter((o) => o.proposalId === p.id).length,
    };
    if (p.status === 'finalized') {
      base.finalized = {
        version: p.finalizedVersion,
        terms: p.finalizedTerms,
        at: p.finalizedAt,
        textRef: p.finalTextRef,
      };
    }

    if (ctx.role === 'collective') {
      base.tally = { ...base.tally, consented: tally.consented, opposed: tally.opposed, pending: tally.pending };
      base.scopePlotIds = p.scopePlotIds;
      base.exitedPlots = p.scopePlotIds
        .filter((pid) => !tally.livePlotIds.includes(pid))
        .map((pid) => ({ plotId: pid, ...state.plots.get(pid)?.exit }));
      if (p.status === 'finalized') base.finalized.scopePlotIds = tally.livePlotIds;
      return base;
    }
    if (ctx.role === 'company') {
      if (ctx.companyId !== p.companyId) fail('forbidden', '无权查看他司提案明细', { status: 403 });
    }
    // company / public / person 都不得在汇总中看到任何家庭标识
    return base;
  }

  /** 跨村民小组汇总：用于村务公开核对参与人数一致性。 */
  groupTallyView(proposalId, ctx = { role: 'public' }) {
    const state = this.#state();
    const p = this.#proposalOrThrow(state, proposalId);
    if (ctx.role === 'company' && ctx.companyId !== p.companyId) {
      fail('forbidden', '无权查看他司提案', { status: 403 });
    }
    const at = this.clock.nowISO();
    const tally = participationTally(state, p, at);

    const groups = new Map();
    for (const householdId of tally.consented) {
      const h = state.households.get(householdId);
      pushGroup(groups, h.group, 'consent', ctx.role === 'collective' ? householdId : null);
    }
    for (const householdId of tally.opposed) {
      const h = state.households.get(householdId);
      pushGroup(groups, h.group, 'oppose', ctx.role === 'collective' ? householdId : null);
    }
    for (const householdId of tally.pending) {
      const h = state.households.get(householdId);
      pushGroup(groups, h.group, 'pending', ctx.role === 'collective' ? householdId : null);
    }
    return {
      proposalId: p.id,
      version: tally.version,
      groups: [...groups.values()].map((g) => ({
        group: g.group,
        totalHouseholds: g.consent.length + g.oppose.length + g.pending.length,
        consentCount: g.consent.length,
        opposeCount: g.oppose.length,
        pendingCount: g.pending.length,
        ...(ctx.role === 'collective'
          ? { consented: g.consent, opposed: g.oppose, pending: g.pending }
          : {}),
      })),
      totalHouseholds: tally.totalHouseholds,
      consentCount: tally.consentCount,
      quorumReached: tally.quorumReached,
    };
  }

  /** 单户视图：仅集体与本户成员可看；公司/公开一律拒绝。 */
  householdView(householdId, ctx) {
    if (ctx?.role !== 'collective') {
      if (!(ctx?.role === 'person')) fail('forbidden', '无权查看家庭资料', { status: 403 });
      const state0 = this.#state();
      const h0 = state0.households.get(householdId);
      if (!h0 || !h0.members.has(ctx.personId)) fail('forbidden', '无权查看他户家庭资料', { status: 403 });
    }
    const state = this.#state();
    const h = state.households.get(householdId);
    if (!h) fail('household_not_found', '家庭不存在', { status: 404 });

    const grants = [...state.grants.values()]
      .filter((g) => g.householdId === householdId)
      .map((g) => ({
        grantId: g.id,
        granterPersonId: g.granterPersonId,
        attorneyPersonId: g.attorneyPersonId,
        actions: [...g.actions],
        plotScope: g.plotScope,
        issuedAt: g.issuedAt,
        expiresAt: g.expiresAt,
        status: g.status === 'active' && g.expiresAt <= this.clock.nowISO() ? 'expired' : g.status,
        revokedAt: g.revokedAt,
      }));

    const plots = h.plotIds.map((pid) => {
      const plot = state.plots.get(pid);
      return { plotId: pid, group: plot.group, exited: plot.exit ?? null };
    });
    const statements = [...state.statements.values()]
      .filter((s) => s.householdId === householdId)
      .map((s) => ({
        statementId: s.id,
        proposalId: s.proposalId,
        version: s.version,
        personId: s.personId,
        viaGrantId: s.viaGrantId,
        position: s.position,
        at: s.at,
        status: s.status,
        withdrewAt: s.withdrewAt ?? null,
      }));
    const objections = [...state.objections.values()]
      .filter((o) => o.householdId === householdId)
      .map((o) => ({
        objectionId: o.id,
        proposalId: o.proposalId,
        version: o.version,
        category: o.category,
        content: o.content,
        at: o.at,
      }));

    return {
      householdId,
      name: h.name,
      group: h.group,
      members: [...h.members.values()],
      grants,
      plots,
      statements,
      objections,
    };
  }

  /** 异议台账：集体全量；公司只见分类计数（内容含家庭信息，不下发）。 */
  objectionsView(proposalId, ctx) {
    const state = this.#state();
    const p = this.#proposalOrThrow(state, proposalId);
    const items = [...state.objections.values()].filter((o) => o.proposalId === proposalId);
    if (ctx?.role === 'collective') {
      return {
        proposalId,
        items: items.map((o) => ({
          objectionId: o.id,
          version: o.version,
          householdId: o.householdId,
          personId: o.personId,
          viaGrantId: o.viaGrantId,
          category: o.category,
          content: o.content,
          at: o.at,
          afterDeadline: o.afterDeadline,
        })),
      };
    }
    if (ctx?.role === 'company' && ctx.companyId === p.companyId) {
      const byCategory = {};
      for (const o of items) byCategory[o.category] = (byCategory[o.category] ?? 0) + 1;
      return { proposalId, count: items.length, byCategory };
    }
    fail('forbidden', '无权查看异议内容', { status: 403 });
  }

  /** 审计用事件序列（集体）。 */
  eventLog(ctx, { fromSeq = 0 } = {}) {
    if (ctx?.role !== 'collective') fail('forbidden', '仅村集体可调取完整事件日志', { status: 403 });
    return { events: this.store.events.filter((e) => e.seq > fromSeq) };
  }
}

function pushGroup(groups, group, kind, householdId) {
  if (!groups.has(group)) {
    groups.set(group, { group, consent: [], oppose: [], pending: [] });
  }
  const bucket = groups.get(group)[kind === 'consent' ? 'consent' : kind === 'oppose' ? 'oppose' : 'pending'];
  if (householdId) bucket.push(householdId);
  else bucket.push(1); // 计数占位，不含任何标识
}
