import { DomainError, fail } from '../domain/errors.mjs';

export const ROLES = Object.freeze({
  OFFICIAL: 'village_official',
  ENTERPRISE: 'enterprise',
  VILLAGER: 'villager',
});

export const STANCES = Object.freeze(['consent', 'dissent', 'abstain']);
export const DELEGATION_ACTIONS = Object.freeze(['statement', 'objection', 'exit']);

/** 法定参与条件默认值：双三分之二（参与户比例、参与户中同意比例） */
const DEFAULT_QUORUM = Object.freeze({
  participationNum: 2,
  participationDen: 3,
  consentNum: 2,
  consentDen: 3,
});

const ACTION_LABELS = Object.freeze({ statement: '表态', objection: '异议', exit: '退出地块' });

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function requireOfficial(actor) {
  if (actor.role !== ROLES.OFFICIAL) {
    fail('FORBIDDEN', '只有村集体管理员可以执行该操作', 403);
  }
}

function asTrimmedString(value, field, { max = 500 } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('VALIDATION', `字段 ${field} 必须是非空字符串`, 400, { field });
  }
  return value.trim().slice(0, max);
}

function asNumber(value, field, { min = 0, integer = false, exclusiveMin = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('VALIDATION', `字段 ${field} 必须是数字`, 400, { field });
  }
  if (exclusiveMin ? value <= min : value < min) {
    fail('VALIDATION', `字段 ${field} 必须${exclusiveMin ? '大于' : '不小于'} ${min}`, 400, { field });
  }
  if (integer && !Number.isInteger(value)) {
    fail('VALIDATION', `字段 ${field} 必须是整数`, 400, { field });
  }
  return value;
}

function asTime(value, field) {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(t)) {
    fail('VALIDATION', `字段 ${field} 必须是合法的日期时间字符串`, 400, { field });
  }
  return t;
}

function asStringArray(value, field, { allowNull = false } = {}) {
  if (value == null && allowNull) return null;
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string' && v.trim() !== '')) {
    fail('VALIDATION', `字段 ${field} 必须是非空字符串数组`, 400, { field });
  }
  return [...new Set(value.map((v) => v.trim()))];
}

function asTerms(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('VALIDATION', '条款 terms 必须是对象', 400, { field: 'terms' });
  }
  return {
    pricePerMu: asNumber(value.pricePerMu, 'terms.pricePerMu'),
    leaseYears: asNumber(value.leaseYears, 'terms.leaseYears', { min: 1, integer: true }),
    guaranteedIncome: asNumber(value.guaranteedIncome, 'terms.guaranteedIncome'),
    exitTerms: asTrimmedString(value.exitTerms, 'terms.exitTerms', { max: 1000 }),
    notes: value.notes == null ? '' : asTrimmedString(value.notes, 'terms.notes', { max: 1000 }),
  };
}

function asQuorum(value) {
  if (value == null) return { ...DEFAULT_QUORUM };
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail('VALIDATION', '法定比例 quorum 必须是对象', 400, { field: 'quorum' });
  }
  const q = {
    participationNum: asNumber(value.participationNum, 'quorum.participationNum', { min: 1, integer: true }),
    participationDen: asNumber(value.participationDen, 'quorum.participationDen', { min: 1, integer: true }),
    consentNum: asNumber(value.consentNum, 'quorum.consentNum', { min: 1, integer: true }),
    consentDen: asNumber(value.consentDen, 'quorum.consentDen', { min: 1, integer: true }),
  };
  if (q.participationNum > q.participationDen || q.consentNum > q.consentDen) {
    fail('VALIDATION', '法定比例的分子不能大于分母', 400, { field: 'quorum' });
  }
  return q;
}

/**
 * 经营权流转协商服务：所有业务规则的唯一入口。
 * 方法均为同步实现，配合注入的 clock 保证并发与到期判断的确定性。
 */
export class NegotiationService {
  constructor(store, clock = () => Date.now()) {
    this.store = store;
    this.clock = clock;
  }

  // ------------------------------------------------------------------
  // 基础资料（村集体维护）
  // ------------------------------------------------------------------

  createActor(actor, input) {
    requireOfficial(actor);
    const role = asTrimmedString(input?.role, 'role');
    if (!Object.values(ROLES).includes(role)) {
      fail('VALIDATION', `未知角色：${role}`, 400, { field: 'role' });
    }
    const name = asTrimmedString(input.name, 'name');
    let householdId = null;
    if (role === ROLES.VILLAGER) {
      householdId = asTrimmedString(input.householdId, 'householdId');
      if (!this.store.households.get(householdId)) {
        fail('NOT_FOUND', '农户家庭不存在', 404);
      }
    }
    const record = { id: this.store.nextId('actor'), name, role, householdId, createdAt: this.clock() };
    this.store.actors.set(record.id, record);
    this.#audit('actor_created', actor, null, { actorId: record.id, role, householdId });
    return record;
  }

  createHousehold(actor, input) {
    requireOfficial(actor);
    const record = {
      id: this.store.nextId('hh'),
      name: asTrimmedString(input?.name, 'name'),
      groupId: asTrimmedString(input?.groupId, 'groupId'),
      createdAt: this.clock(),
    };
    this.store.households.set(record.id, record);
    this.#audit('household_created', actor, null, { householdId: record.id, groupId: record.groupId });
    return record;
  }

  createPlot(actor, input) {
    requireOfficial(actor);
    const householdId = asTrimmedString(input?.householdId, 'householdId');
    if (!this.store.households.get(householdId)) {
      fail('NOT_FOUND', '农户家庭不存在', 404);
    }
    const record = {
      id: this.store.nextId('plot'),
      name: asTrimmedString(input?.name, 'name'),
      householdId,
      area: asNumber(input?.area, 'area', { min: 0, exclusiveMin: true }),
      createdAt: this.clock(),
    };
    this.store.plots.set(record.id, record);
    this.#audit('plot_created', actor, null, { plotId: record.id, householdId });
    return record;
  }

  getMe(actor) {
    const household = actor.householdId ? this.store.households.get(actor.householdId) ?? null : null;
    const plots = actor.householdId
      ? [...this.store.plots.values()].filter((p) => p.householdId === actor.householdId)
      : [];
    return {
      actor: { ...actor },
      household,
      plots,
      delegations: this.listDelegations(actor),
    };
  }

  // ------------------------------------------------------------------
  // 委托授权
  // ------------------------------------------------------------------

  createDelegation(actor, input) {
    const delegatorId = asTrimmedString(input?.delegatorId, 'delegatorId');
    const delegateId = asTrimmedString(input?.delegateId, 'delegateId');
    if (actor.role !== ROLES.OFFICIAL && actor.id !== delegatorId) {
      fail('FORBIDDEN', '只能以本人名义创建委托授权', 403);
    }
    if (delegatorId === delegateId) {
      fail('VALIDATION', '委托人与受托人不能是同一人', 400);
    }
    const delegator = this.store.actors.get(delegatorId);
    const delegate = this.store.actors.get(delegateId);
    if (!delegator || delegator.role !== ROLES.VILLAGER) {
      fail('NOT_FOUND', '委托人必须是本村农户成员', 404);
    }
    if (!delegate || delegate.role !== ROLES.VILLAGER) {
      fail('NOT_FOUND', '受托人必须是本村农户成员', 404);
    }
    const actions = asStringArray(input?.actions, 'actions');
    for (const action of actions) {
      if (!DELEGATION_ACTIONS.includes(action)) {
        fail('VALIDATION', `不支持的委托事项：${action}`, 400, { field: 'actions' });
      }
    }
    const proposalIds = asStringArray(input?.proposalIds, 'proposalIds', { allowNull: true });
    if (proposalIds) {
      for (const pid of proposalIds) {
        if (!this.store.proposals.get(pid)) {
          fail('NOT_FOUND', `方案不存在：${pid}`, 404);
        }
      }
    }
    const validUntil = asTime(input?.validUntil, 'validUntil');
    const now = this.clock();
    if (now > validUntil) {
      fail('VALIDATION', '委托截止时间必须晚于当前时间', 400, { field: 'validUntil' });
    }
    const existing = [...this.store.delegations.values()].find(
      (d) => d.delegatorId === delegatorId && d.delegateId === delegateId && d.status === 'active' && d.validUntil >= now,
    );
    if (existing) {
      fail('DELEGATION_EXISTS', '两人之间已存在有效的委托授权，请先撤销再重新授权', 409, { delegationId: existing.id });
    }
    const record = {
      id: this.store.nextId('del'),
      delegatorId,
      delegateId,
      proposalIds,
      actions,
      validUntil,
      status: 'active',
      createdAt: now,
      revokedAt: null,
    };
    this.store.delegations.set(record.id, record);
    this.#audit('delegation_created', actor, null, {
      delegationId: record.id,
      delegatorId,
      delegateId,
      actions,
      proposalIds,
      validUntil: iso(validUntil),
    });
    return this.#delegationView(record);
  }

  revokeDelegation(actor, delegationId) {
    const delegation = this.store.delegations.get(delegationId);
    if (!delegation) {
      fail('NOT_FOUND', '委托授权不存在', 404);
    }
    if (actor.role !== ROLES.OFFICIAL && actor.id !== delegation.delegatorId) {
      fail('FORBIDDEN', '只有委托本人或村集体可以撤销委托', 403);
    }
    if (delegation.status !== 'active') {
      fail('INVALID_STATUS', '委托授权已被撤销', 409);
    }
    delegation.status = 'revoked';
    delegation.revokedAt = this.clock();
    this.#audit('delegation_revoked', actor, null, { delegationId: delegation.id });
    return this.#delegationView(delegation);
  }

  listDelegations(actor) {
    const all = [...this.store.delegations.values()];
    const visible =
      actor.role === ROLES.OFFICIAL
        ? all
        : all.filter((d) => d.delegatorId === actor.id || d.delegateId === actor.id);
    return visible.map((d) => this.#delegationView(d));
  }

  // ------------------------------------------------------------------
  // 流转方案与文本版本
  // ------------------------------------------------------------------

  createProposal(actor, input) {
    if (![ROLES.ENTERPRISE, ROLES.OFFICIAL].includes(actor.role)) {
      fail('FORBIDDEN', '只有项目公司或村集体可以发起流转方案', 403);
    }
    const title = asTrimmedString(input?.title, 'title', { max: 200 });
    const groupIds = asStringArray(input?.groupIds, 'groupIds');
    const plotIds = asStringArray(input?.plotIds, 'plotIds');
    for (const pid of plotIds) {
      const plot = this.store.plots.get(pid);
      if (!plot) {
        fail('NOT_FOUND', `地块不存在：${pid}`, 404);
      }
      const household = this.store.households.get(plot.householdId);
      if (!household || !groupIds.includes(household.groupId)) {
        fail('VALIDATION', `地块 ${pid} 所在村民小组不在方案范围内`, 400, { field: 'plotIds' });
      }
    }
    const terms = asTerms(input?.terms);
    const deadline = asTime(input?.deadline, 'deadline');
    if (this.clock() > deadline) {
      fail('VALIDATION', '协商截止时间必须晚于当前时间', 400, { field: 'deadline' });
    }
    const quorum = asQuorum(input?.quorum);
    const now = this.clock();
    const proposal = {
      id: this.store.nextId('prop'),
      title,
      creatorActorId: actor.id,
      groupIds,
      plotScope: [...plotIds].sort(),
      deadline,
      quorum,
      status: 'draft',
      currentVersionId: null,
      createdAt: now,
    };
    const version = {
      id: this.store.nextId('ver'),
      proposalId: proposal.id,
      number: 1,
      terms,
      createdById: actor.id,
      createdAt: now,
      finalizedAt: null,
    };
    proposal.currentVersionId = version.id;
    this.store.proposals.set(proposal.id, proposal);
    this.store.versions.set(version.id, version);
    this.#audit('proposal_created', actor, proposal.id, {
      title,
      groupIds,
      plotIds: proposal.plotScope,
      deadline: iso(deadline),
    });
    this.#audit('version_created', actor, proposal.id, { versionId: version.id, number: 1, terms });
    return this.#proposalView(actor, proposal);
  }

  publishProposal(actor, proposalId) {
    const proposal = this.#loadProposal(proposalId);
    this.#assertCreatorOrOfficial(actor, proposal);
    if (proposal.status !== 'draft') {
      fail('INVALID_STATUS', '只有草稿状态的方案可以发布', 409, { status: proposal.status });
    }
    proposal.status = 'open';
    this.#audit('proposal_published', actor, proposal.id, {});
    return this.#proposalView(actor, proposal);
  }

  cancelProposal(actor, proposalId) {
    requireOfficial(actor);
    const proposal = this.#loadProposal(proposalId);
    if (!['draft', 'open'].includes(proposal.status)) {
      fail('INVALID_STATUS', '当前状态不允许作废', 409, { status: proposal.status });
    }
    proposal.status = 'cancelled';
    this.#audit('proposal_cancelled', actor, proposal.id, {});
    return this.#proposalView(actor, proposal);
  }

  getProposal(actor, proposalId) {
    return this.#proposalView(actor, this.#loadVisibleProposal(actor, proposalId));
  }

  listProposals(actor) {
    return [...this.store.proposals.values()]
      .filter((p) => this.#canView(actor, p))
      .map((p) => this.#proposalView(actor, p));
  }

  listVersions(actor, proposalId) {
    const proposal = this.#loadVisibleProposal(actor, proposalId);
    return [...this.store.versions.values()]
      .filter((v) => v.proposalId === proposal.id)
      .sort((a, b) => a.number - b.number)
      .map((v) => ({
        id: v.id,
        number: v.number,
        terms: { ...v.terms },
        createdBy: this.#actorLabel(v.createdById),
        createdAt: iso(v.createdAt),
        finalizedAt: iso(v.finalizedAt),
        current: v.id === proposal.currentVersionId,
      }));
  }

  /**
   * 企业改价 / 文本修订：必须携带 expectedVersion 做乐观并发控制。
   * 两个并发改价请求中，先落库者生效，后到者得到确定性的 VERSION_CONFLICT。
   */
  createVersion(actor, proposalId, input) {
    const proposal = this.#loadProposal(proposalId);
    this.#assertCreatorOrOfficial(actor, proposal);
    this.#assertOpenAndBeforeDeadline(proposal);
    const current = this.store.versions.get(proposal.currentVersionId);
    const expectedVersion = asNumber(input?.expectedVersion, 'expectedVersion', { min: 1, integer: true });
    if (expectedVersion !== current.number) {
      fail('VERSION_CONFLICT', '文本版本已被他人更新，请基于最新版本重新修改', 409, {
        currentVersion: current.number,
      });
    }
    const terms = asTerms(input?.terms);
    const version = {
      id: this.store.nextId('ver'),
      proposalId: proposal.id,
      number: current.number + 1,
      terms,
      createdById: actor.id,
      createdAt: this.clock(),
      finalizedAt: null,
    };
    this.store.versions.set(version.id, version);
    proposal.currentVersionId = version.id;
    this.#audit('version_created', actor, proposal.id, { versionId: version.id, number: version.number, terms });
    return this.listVersions(actor, proposalId).find((v) => v.id === version.id);
  }

  // ------------------------------------------------------------------
  // 表态（意见）
  // ------------------------------------------------------------------

  /**
   * 提交表态。同一委托人在同一文本版本上重复提交相同内容时幂等返回原记录；
   * 内容不同则确定性拒绝，须先撤回再重新表态。
   */
  submitStatement(actor, proposalId, input) {
    const proposal = this.#loadVisibleProposal(actor, proposalId);
    this.#assertOpenAndBeforeDeadline(proposal);
    const stance = asTrimmedString(input?.stance, 'stance');
    if (!STANCES.includes(stance)) {
      fail('VALIDATION', `立场必须是 ${STANCES.join(' / ')} 之一`, 400, { field: 'stance' });
    }
    const comment = input?.comment == null ? '' : asTrimmedString(input.comment, 'comment', { max: 2000 });
    const principalId = this.#resolvePrincipal(actor, proposal.id, 'statement', input?.onBehalfOf ?? null);
    this.#assertEligibleHousehold(proposal, principalId);
    const versionId = proposal.currentVersionId;
    const existing = [...this.store.statements.values()].find(
      (s) => s.proposalId === proposal.id && s.versionId === versionId && s.principalId === principalId && s.status === 'active',
    );
    if (existing) {
      if (existing.stance === stance && existing.comment === comment) {
        return { statement: this.#statementView(actor, existing), duplicated: true };
      }
      fail('DUPLICATE_STATEMENT', '已存在有效表态，如需变更请先撤回原表态', 409, { statementId: existing.id });
    }
    const record = {
      id: this.store.nextId('stmt'),
      seq: this.store.nextSeq('statement'),
      proposalId: proposal.id,
      versionId,
      principalId,
      actorId: actor.id,
      stance,
      comment,
      status: 'active',
      createdAt: this.clock(),
      withdrawnAt: null,
    };
    this.store.statements.set(record.id, record);
    this.#audit('statement_submitted', actor, proposal.id, {
      statementId: record.id,
      principalId,
      versionNumber: this.store.versions.get(versionId).number,
      stance,
    });
    return { statement: this.#statementView(actor, record), duplicated: false };
  }

  /** 截止前撤回表态；截止后一律确定性拒绝 */
  withdrawStatement(actor, statementId) {
    const record = this.store.statements.get(statementId);
    if (!record) {
      fail('NOT_FOUND', '表态记录不存在', 404);
    }
    const proposal = this.store.proposals.get(record.proposalId);
    if (!this.#canView(actor, proposal)) {
      fail('NOT_FOUND', '表态记录不存在或不可见', 404);
    }
    this.#assertOpenAndBeforeDeadline(proposal);
    if (record.status !== 'active') {
      fail('INVALID_STATUS', '该表态已撤回', 409);
    }
    const isPrincipal = record.principalId === actor.id;
    const isSubmitter = record.actorId === actor.id;
    if (!isPrincipal && !isSubmitter) {
      fail('FORBIDDEN', '只有表态本人或代为提交人可以撤回', 403);
    }
    if (isSubmitter && !isPrincipal) {
      // 代提交人撤回时，委托授权必须仍然有效
      this.#resolvePrincipal(actor, proposal.id, 'statement', record.principalId);
    }
    record.status = 'withdrawn';
    record.withdrawnAt = this.clock();
    this.#audit('statement_withdrawn', actor, proposal.id, { statementId: record.id, principalId: record.principalId });
    return this.#statementView(actor, record);
  }

  /**
   * 表态列表：村集体看全部；农户只看本户；企业不可看家庭级表态（仅有汇总）。
   */
  listStatements(actor, proposalId) {
    const proposal = this.#loadVisibleProposal(actor, proposalId);
    if (actor.role === ROLES.ENTERPRISE) {
      fail('FORBIDDEN', '企业只能查看汇总结果，不能查看家庭级表态明细', 403);
    }
    const all = [...this.store.statements.values()]
      .filter((s) => s.proposalId === proposal.id)
      .sort((a, b) => a.seq - b.seq);
    const visible =
      actor.role === ROLES.OFFICIAL
        ? all
        : all.filter((s) => this.store.actors.get(s.principalId)?.householdId === actor.householdId);
    return visible.map((s) => this.#statementView(actor, s));
  }

  // ------------------------------------------------------------------
  // 异议（留痕）
  // ------------------------------------------------------------------

  raiseObjection(actor, proposalId, input) {
    const proposal = this.#loadVisibleProposal(actor, proposalId);
    if (proposal.status !== 'open') {
      fail('INVALID_STATUS', '当前状态不允许提出异议', 409, { status: proposal.status });
    }
    const reason = asTrimmedString(input?.reason, 'reason', { max: 2000 });
    const principalId = this.#resolvePrincipal(actor, proposal.id, 'objection', input?.onBehalfOf ?? null);
    this.#assertEligibleHousehold(proposal, principalId);
    const record = {
      id: this.store.nextId('obj'),
      proposalId: proposal.id,
      versionId: proposal.currentVersionId,
      principalId,
      actorId: actor.id,
      reason,
      status: 'open',
      createdAt: this.clock(),
      resolvedAt: null,
      resolvedById: null,
      resolution: null,
      withdrawnAt: null,
    };
    this.store.objections.set(record.id, record);
    this.#audit('objection_raised', actor, proposal.id, {
      objectionId: record.id,
      principalId,
      versionNumber: this.store.versions.get(record.versionId).number,
    });
    return this.#objectionView(actor, record);
  }

  resolveObjection(actor, objectionId, input) {
    requireOfficial(actor);
    const record = this.store.objections.get(objectionId);
    if (!record) {
      fail('NOT_FOUND', '异议不存在', 404);
    }
    if (record.status !== 'open') {
      fail('INVALID_STATUS', '该异议已处理或已撤回', 409, { status: record.status });
    }
    record.status = 'resolved';
    record.resolution = asTrimmedString(input?.resolution, 'resolution', { max: 2000 });
    record.resolvedAt = this.clock();
    record.resolvedById = actor.id;
    this.#audit('objection_resolved', actor, record.proposalId, { objectionId: record.id });
    return this.#objectionView(actor, record);
  }

  withdrawObjection(actor, objectionId) {
    const record = this.store.objections.get(objectionId);
    if (!record) {
      fail('NOT_FOUND', '异议不存在', 404);
    }
    const proposal = this.store.proposals.get(record.proposalId);
    if (!this.#canView(actor, proposal)) {
      fail('NOT_FOUND', '异议不存在或不可见', 404);
    }
    if (proposal.status !== 'open') {
      fail('INVALID_STATUS', '当前状态不允许撤回异议', 409, { status: proposal.status });
    }
    if (record.status !== 'open') {
      fail('INVALID_STATUS', '该异议已处理或已撤回', 409, { status: record.status });
    }
    const isPrincipal = record.principalId === actor.id;
    const isSubmitter = record.actorId === actor.id;
    if (!isPrincipal && !isSubmitter) {
      fail('FORBIDDEN', '只有异议本人或代为提交人可以撤回', 403);
    }
    if (isSubmitter && !isPrincipal) {
      this.#resolvePrincipal(actor, proposal.id, 'objection', record.principalId);
    }
    record.status = 'withdrawn';
    record.withdrawnAt = this.clock();
    this.#audit('objection_withdrawn', actor, record.proposalId, { objectionId: record.id });
    return this.#objectionView(actor, record);
  }

  /** 异议对参与者公开留痕，但非村集体角色只能看到匿名化的提出方信息 */
  listObjections(actor, proposalId) {
    const proposal = this.#loadVisibleProposal(actor, proposalId);
    return [...this.store.objections.values()]
      .filter((o) => o.proposalId === proposal.id)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((o) => this.#objectionView(actor, o));
  }

  // ------------------------------------------------------------------
  // 地块退出
  // ------------------------------------------------------------------

  /** 少数地块退出：截止前把本户地块移出方案范围，应参与户基数随之确定性收缩 */
  exitPlots(actor, proposalId, input) {
    const proposal = this.#loadVisibleProposal(actor, proposalId);
    this.#assertOpenAndBeforeDeadline(proposal);
    let householdId;
    if (actor.role === ROLES.OFFICIAL && input?.householdId != null) {
      householdId = asTrimmedString(input.householdId, 'householdId');
    } else {
      const principalId = this.#resolvePrincipal(actor, proposal.id, 'exit', input?.onBehalfOf ?? null);
      householdId = this.store.actors.get(principalId)?.householdId;
    }
    if (!householdId || !this.store.households.get(householdId)) {
      fail('FORBIDDEN', '只有农户家庭可以退出地块', 403);
    }
    const plotIds = asStringArray(input?.plotIds, 'plotIds');
    for (const pid of plotIds) {
      const plot = this.store.plots.get(pid);
      if (!plot) {
        fail('NOT_FOUND', `地块不存在：${pid}`, 404);
      }
      if (plot.householdId !== householdId) {
        fail('NOT_PLOT_OWNER', '只能退出本户名下的地块', 403, { plotId: pid });
      }
      if (!proposal.plotScope.includes(pid)) {
        fail('PLOT_NOT_IN_SCOPE', '地块不在本方案范围内', 409, { plotId: pid });
      }
    }
    proposal.plotScope = proposal.plotScope.filter((id) => !plotIds.includes(id));
    this.#audit('plots_exited', actor, proposal.id, { householdId, plotIds });
    return {
      proposalId: proposal.id,
      householdId,
      exited: plotIds,
      remainingPlotCount: proposal.plotScope.length,
      householdRemaining: proposal.plotScope.filter(
        (id) => this.store.plots.get(id)?.householdId === householdId,
      ).length,
    };
  }

  // ------------------------------------------------------------------
  // 汇总与法定参与条件
  // ------------------------------------------------------------------

  /**
   * 汇总视图：任何角色都只拿到其权限范围内的数据。
   * 家庭级明细仅村集体可见；农户额外看到本户；企业只有聚合数字。
   */
  getSummary(actor, proposalId) {
    const proposal = this.#loadVisibleProposal(actor, proposalId);
    const q = this.#computeQuorum(proposal);
    const version = this.store.versions.get(proposal.currentVersionId);
    const openObjections = [...this.store.objections.values()].filter(
      (o) => o.proposalId === proposal.id && o.versionId === proposal.currentVersionId && o.status === 'open',
    ).length;
    const summary = {
      proposalId: proposal.id,
      status: proposal.status,
      version: { id: version.id, number: version.number },
      deadline: iso(proposal.deadline),
      generatedAt: iso(this.clock()),
      quorum: { ...proposal.quorum },
      eligibleHouseholds: q.eligible,
      participatedHouseholds: q.participated,
      consentingHouseholds: q.consenting,
      participationMet: q.participationMet,
      consentMet: q.consentMet,
      quorumMet: q.quorumMet,
      byStance: q.byStance,
      byGroup: q.byGroup,
      scope: {
        groupIds: [...proposal.groupIds],
        plotCount: q.scopePlots.length,
        totalArea: round4(q.scopePlots.reduce((sum, p) => sum + p.area, 0)),
      },
      openObjections,
    };
    if (actor.role === ROLES.OFFICIAL) {
      summary.households = [...q.eligibleHouseholdIds].map((hid) => this.#householdDetail(hid, q));
    }
    if (actor.role === ROLES.VILLAGER && actor.householdId && q.eligibleHouseholdIds.has(actor.householdId)) {
      summary.ownHousehold = this.#householdDetail(actor.householdId, q);
    }
    return summary;
  }

  /** 达到法定参与条件后才能进入签署；结果与当时版本、人数一并留痕 */
  enterSigning(actor, proposalId) {
    requireOfficial(actor);
    const proposal = this.#loadProposal(proposalId);
    if (proposal.status !== 'open') {
      fail('INVALID_STATUS', '只有协商中的方案可以进入签署', 409, { status: proposal.status });
    }
    const q = this.#computeQuorum(proposal);
    if (q.eligible === 0) {
      fail('NO_ELIGIBLE_HOUSEHOLDS', '方案范围内已无符合条件的农户，不能进入签署', 409);
    }
    if (!q.quorumMet) {
      fail('QUORUM_NOT_MET', '未达到法定参与条件，不能进入签署', 409, {
        eligibleHouseholds: q.eligible,
        participatedHouseholds: q.participated,
        consentingHouseholds: q.consenting,
        participationMet: q.participationMet,
        consentMet: q.consentMet,
        quorum: { ...proposal.quorum },
      });
    }
    proposal.status = 'signing';
    const version = this.store.versions.get(proposal.currentVersionId);
    version.finalizedAt = this.clock();
    this.#audit('entered_signing', actor, proposal.id, {
      versionNumber: version.number,
      eligibleHouseholds: q.eligible,
      participatedHouseholds: q.participated,
      consentingHouseholds: q.consenting,
    });
    return this.#proposalView(actor, proposal);
  }

  /** 审计留痕仅村集体可查 */
  getAudit(actor, proposalId) {
    requireOfficial(actor);
    if (!this.store.proposals.get(proposalId)) {
      fail('NOT_FOUND', '方案不存在', 404);
    }
    return this.store.audit
      .filter((e) => e.proposalId === proposalId)
      .map((e) => ({
        ...e,
        at: iso(e.at),
        actorName: this.store.actors.get(e.actorId)?.name ?? null,
      }));
  }

  // ------------------------------------------------------------------
  // 内部规则
  // ------------------------------------------------------------------

  #audit(type, actor, proposalId, details) {
    return this.store.record({ type, actorId: actor.id, proposalId, at: this.clock(), details });
  }

  #loadProposal(proposalId) {
    const proposal = this.store.proposals.get(proposalId);
    if (!proposal) {
      fail('NOT_FOUND', '方案不存在', 404);
    }
    return proposal;
  }

  #loadVisibleProposal(actor, proposalId) {
    const proposal = this.store.proposals.get(proposalId);
    if (!proposal || !this.#canView(actor, proposal)) {
      fail('NOT_FOUND', '方案不存在或不可见', 404);
    }
    return proposal;
  }

  /**
   * 可见性：村集体全量；企业只看自己发起的；农户只看本组在范围内且已发布的。
   * 范围外一律按 404 处理，避免泄露方案存在性。
   */
  #canView(actor, proposal) {
    if (!proposal) return false;
    if (actor.role === ROLES.OFFICIAL) return true;
    if (actor.role === ROLES.ENTERPRISE) return proposal.creatorActorId === actor.id;
    const household = actor.householdId ? this.store.households.get(actor.householdId) : null;
    return !!household && proposal.groupIds.includes(household.groupId) && proposal.status !== 'draft';
  }

  #assertCreatorOrOfficial(actor, proposal) {
    if (actor.role === ROLES.OFFICIAL) return;
    if (actor.role === ROLES.ENTERPRISE && proposal.creatorActorId === actor.id) return;
    fail('FORBIDDEN', '只有方案发起方或村集体可以执行该操作', 403);
  }

  /** 协商期内（发布状态且未过截止时间）才允许变更参与性数据 */
  #assertOpenAndBeforeDeadline(proposal) {
    if (proposal.status !== 'open') {
      fail('INVALID_STATUS', '当前状态不允许该操作', 409, { status: proposal.status });
    }
    if (this.clock() > proposal.deadline) {
      fail('DEADLINE_PASSED', '协商截止时间已过，不能再变更', 409, { deadline: iso(proposal.deadline) });
    }
  }

  /**
   * 解析实际表态人：无委托时即本人；有委托时依次确定性校验
   * 授权存在 → 未撤销 → 未到期 → 事项在范围内 → 方案在范围内。
   */
  #resolvePrincipal(actor, proposalId, action, onBehalfOf) {
    if (!onBehalfOf) {
      return actor.id;
    }
    if (onBehalfOf === actor.id) {
      fail('VALIDATION', '不能以委托自己的方式操作', 400);
    }
    const delegator = this.store.actors.get(onBehalfOf);
    if (!delegator) {
      fail('NOT_FOUND', '委托人不存在', 404);
    }
    const candidates = [...this.store.delegations.values()].filter(
      (d) => d.delegatorId === onBehalfOf && d.delegateId === actor.id,
    );
    const delegation = candidates.find((d) => d.status === 'active') ?? candidates[candidates.length - 1] ?? null;
    if (!delegation) {
      fail('FORBIDDEN', '不存在对应的委托授权', 403);
    }
    if (delegation.status !== 'active') {
      fail('DELEGATION_REVOKED', '委托授权已被撤销', 403);
    }
    if (this.clock() > delegation.validUntil) {
      fail('DELEGATION_EXPIRED', '委托授权已到期', 403, { validUntil: iso(delegation.validUntil) });
    }
    if (!delegation.actions.includes(action)) {
      fail('DELEGATION_SCOPE', `委托范围不包含「${ACTION_LABELS[action] ?? action}」事项`, 403);
    }
    if (delegation.proposalIds && !delegation.proposalIds.includes(proposalId)) {
      fail('DELEGATION_SCOPE', '委托范围不包含本方案', 403);
    }
    return delegator.id;
  }

  /** 参与资格：本人须属于范围内村民小组、且本户在方案范围内仍有地块 */
  #assertEligibleHousehold(proposal, principalId) {
    const principal = this.store.actors.get(principalId);
    const household = principal?.householdId ? this.store.households.get(principal.householdId) : null;
    if (!household) {
      fail('FORBIDDEN', '表态人必须属于某个农户家庭', 403);
    }
    if (!proposal.groupIds.includes(household.groupId)) {
      fail('FORBIDDEN', '所在村民小组不在本方案范围内', 403);
    }
    const hasPlot = proposal.plotScope.some((pid) => this.store.plots.get(pid)?.householdId === household.id);
    if (!hasPlot) {
      fail('FORBIDDEN', '本户在方案范围内没有地块，无权参与本方案', 403);
    }
    return household;
  }

  /**
   * 法定参与条件计算（全部整数比较，结果确定）：
   * 应参与户 = 范围内仍有地块的户；参与户 = 当前版本上有有效表态的户；
   * 一户多人表态时，以序号最新的一条有效表态为准。
   */
  #computeQuorum(proposal) {
    const scopePlots = proposal.plotScope.map((id) => this.store.plots.get(id)).filter(Boolean);
    const eligibleHouseholdIds = new Set(scopePlots.map((p) => p.householdId));
    const latestByHousehold = new Map();
    for (const stmt of this.store.statements.values()) {
      if (stmt.proposalId !== proposal.id || stmt.versionId !== proposal.currentVersionId || stmt.status !== 'active') {
        continue;
      }
      const householdId = this.store.actors.get(stmt.principalId)?.householdId;
      if (!householdId || !eligibleHouseholdIds.has(householdId)) {
        continue;
      }
      const prev = latestByHousehold.get(householdId);
      if (!prev || stmt.seq > prev.seq) {
        latestByHousehold.set(householdId, stmt);
      }
    }
    const byStance = { consent: 0, dissent: 0, abstain: 0 };
    for (const stmt of latestByHousehold.values()) {
      byStance[stmt.stance] += 1;
    }
    const eligible = eligibleHouseholdIds.size;
    const participated = latestByHousehold.size;
    const consenting = byStance.consent;
    const q = proposal.quorum;
    const participationMet = eligible > 0 && participated * q.participationDen >= eligible * q.participationNum;
    const consentMet = participated > 0 && consenting * q.consentDen >= participated * q.consentNum;
    const byGroupMap = new Map();
    for (const hid of eligibleHouseholdIds) {
      const household = this.store.households.get(hid);
      const groupId = household?.groupId ?? '未知';
      if (!byGroupMap.has(groupId)) {
        byGroupMap.set(groupId, { groupId, eligible: 0, participated: 0, consenting: 0 });
      }
      const row = byGroupMap.get(groupId);
      row.eligible += 1;
      const stmt = latestByHousehold.get(hid);
      if (stmt) {
        row.participated += 1;
        if (stmt.stance === 'consent') {
          row.consenting += 1;
        }
      }
    }
    return {
      eligible,
      participated,
      consenting,
      byStance,
      participationMet,
      consentMet,
      quorumMet: participationMet && consentMet,
      byGroup: [...byGroupMap.values()].sort((a, b) => a.groupId.localeCompare(b.groupId)),
      latestByHousehold,
      eligibleHouseholdIds,
      scopePlots,
    };
  }

  #householdDetail(householdId, quorumResult) {
    const household = this.store.households.get(householdId);
    const latest = quorumResult.latestByHousehold.get(householdId) ?? null;
    return {
      householdId,
      name: household?.name ?? null,
      groupId: household?.groupId ?? null,
      stance: latest?.stance ?? null,
      plots: quorumResult.scopePlots
        .filter((p) => p.householdId === householdId)
        .map((p) => ({ id: p.id, name: p.name, area: p.area })),
    };
  }

  #actorLabel(actorId) {
    const actor = this.store.actors.get(actorId);
    return actor ? { actorId: actor.id, name: actor.name, role: actor.role } : null;
  }

  /**
   * 家庭资料脱敏：村集体与家庭成员本人可见完整信息，
   * 其他角色只能看到角色与所在村民小组。
   */
  #principalView(actor, principalId) {
    const principal = this.store.actors.get(principalId);
    if (!principal) return null;
    const household = principal.householdId ? this.store.households.get(principal.householdId) : null;
    const canSeeFull =
      actor.role === ROLES.OFFICIAL || (actor.householdId != null && actor.householdId === principal.householdId);
    if (canSeeFull) {
      return {
        actorId: principal.id,
        name: principal.name,
        householdId: household?.id ?? null,
        householdName: household?.name ?? null,
        groupId: household?.groupId ?? null,
      };
    }
    return { role: principal.role, groupId: household?.groupId ?? null };
  }

  #statementView(actor, record) {
    const version = this.store.versions.get(record.versionId);
    return {
      id: record.id,
      proposalId: record.proposalId,
      versionNumber: version?.number ?? null,
      stance: record.stance,
      comment: record.comment,
      status: record.status,
      principal: this.#principalView(actor, record.principalId),
      submittedBy: record.actorId === record.principalId ? 'self' : 'delegate',
      createdAt: iso(record.createdAt),
      withdrawnAt: iso(record.withdrawnAt),
    };
  }

  #objectionView(actor, record) {
    const version = this.store.versions.get(record.versionId);
    return {
      id: record.id,
      proposalId: record.proposalId,
      versionNumber: version?.number ?? null,
      reason: record.reason,
      status: record.status,
      author: this.#principalView(actor, record.principalId),
      resolution: record.resolution,
      createdAt: iso(record.createdAt),
      resolvedAt: iso(record.resolvedAt),
      withdrawnAt: iso(record.withdrawnAt),
    };
  }

  #delegationView(record) {
    return {
      id: record.id,
      delegatorId: record.delegatorId,
      delegateId: record.delegateId,
      proposalIds: record.proposalIds ? [...record.proposalIds] : null,
      actions: [...record.actions],
      status: record.status,
      expired: this.clock() > record.validUntil,
      validUntil: iso(record.validUntil),
      createdAt: iso(record.createdAt),
      revokedAt: iso(record.revokedAt),
    };
  }

  #proposalView(actor, proposal) {
    const version = this.store.versions.get(proposal.currentVersionId);
    const scopePlots = proposal.plotScope.map((id) => this.store.plots.get(id)).filter(Boolean);
    const view = {
      id: proposal.id,
      title: proposal.title,
      status: proposal.status,
      groupIds: [...proposal.groupIds],
      deadline: iso(proposal.deadline),
      quorum: { ...proposal.quorum },
      creator: this.#actorLabel(proposal.creatorActorId),
      currentVersion: {
        id: version.id,
        number: version.number,
        terms: { ...version.terms },
        createdAt: iso(version.createdAt),
        finalizedAt: iso(version.finalizedAt),
      },
      scope: {
        plotCount: scopePlots.length,
        totalArea: round4(scopePlots.reduce((sum, p) => sum + p.area, 0)),
      },
      createdAt: iso(proposal.createdAt),
    };
    if (actor.role === ROLES.OFFICIAL) {
      view.scope.plots = scopePlots.map((plot) => {
        const household = this.store.households.get(plot.householdId);
        return {
          id: plot.id,
          name: plot.name,
          area: plot.area,
          householdId: plot.householdId,
          householdName: household?.name ?? null,
          groupId: household?.groupId ?? null,
        };
      });
    } else if (actor.role === ROLES.VILLAGER && actor.householdId) {
      view.ownHouseholdPlots = scopePlots
        .filter((plot) => plot.householdId === actor.householdId)
        .map((plot) => ({ id: plot.id, name: plot.name, area: plot.area }));
    }
    return view;
  }
}
