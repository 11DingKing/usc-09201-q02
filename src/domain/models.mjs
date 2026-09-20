/**
 * 纯函数投影：事件列表 -> 当前领域状态。
 * 不做任何写操作，便于对任意历史切片重放、审计与测试。
 *
 * 状态形态：
 *   households: Map<householdId, {id,name,group, eligiblePlotIds:Set, members:Map}>
 *   plots:      Map<plotId, {id, householdId, group}>
 *   proposals:  Map<id, proposalState>
 *   grants:     Map<grantId, grantState>
 *   statements: Map<statementId, statementState>
 *   objections: Map<objectionId, objectionState>
 */

export function reduce(events) {
  const state = {
    companies: new Map(),
    households: new Map(),
    plots: new Map(),
    proposals: new Map(),
    grants: new Map(),
    statements: new Map(),
    objections: new Map(),
  };

  for (const event of events) {
    apply(state, event);
  }
  return state;
}

function apply(state, event) {
  const { seq, at, type, data } = event;
  switch (type) {
    case 'company-registered': {
      state.companies.set(data.companyId, { id: data.companyId, name: data.name, registeredAt: at });
      return;
    }
    case 'household-registered': {
      state.households.set(data.householdId, {
        id: data.householdId,
        name: data.name,
        group: data.group,
        members: new Map(data.members.map((m) => [m.personId, { ...m }])),
        plotIds: [],
      });
      return;
    }
    case 'plot-registered': {
      state.plots.set(data.plotId, {
        id: data.plotId,
        householdId: data.householdId,
        group: data.group,
      });
      state.households.get(data.householdId)?.plotIds.push(data.plotId);
      return;
    }
    case 'proposal-created': {
      state.proposals.set(data.proposalId, {
        id: data.proposalId,
        companyId: data.companyId,
        scopePlotIds: [...data.scopePlotIds],
        threshold: data.threshold,
        deadline: data.deadline,
        versions: [],
        status: 'open',
        finalizedVersion: null,
        finalizedAt: null,
      });
      return;
    }
    case 'proposal-revised': {
      const p = state.proposals.get(data.proposalId);
      p.versions.push({
        version: data.version,
        terms: data.terms,
        publishedAt: at,
      });
      return;
    }
    case 'proposal-deadline-extended': {
      state.proposals.get(data.proposalId).deadline = data.newDeadline;
      return;
    }
    case 'proposal-finalized': {
      const p = state.proposals.get(data.proposalId);
      p.status = 'finalized';
      p.finalizedVersion = data.version;
      p.finalizedTerms = data.terms;
      p.finalizedAt = at;
      p.finalTextRef = data.textRef;
      return;
    }
    case 'grant-issued': {
      state.grants.set(data.grantId, {
        id: data.grantId,
        householdId: data.householdId,
        granterPersonId: data.granterPersonId,
        attorneyPersonId: data.attorneyPersonId,
        actions: new Set(data.actions),
        plotScope: data.plotScope ?? null,
        issuedAt: at,
        expiresAt: data.expiresAt,
        status: 'active',
        revokedAt: null,
        revocationReason: null,
      });
      return;
    }
    case 'grant-revoked': {
      const g = state.grants.get(data.grantId);
      g.status = 'revoked';
      g.revokedAt = at;
      g.revocationReason = data.reason ?? null;
      return;
    }
    case 'plot-exit-filed': {
      state.plots.get(data.plotId).exit = {
        at: at,
        personId: data.personId,
        reason: data.reason ?? null,
        fromVersion: data.fromVersion,
      };
      return;
    }
    case 'statement-made': {
      state.statements.set(data.statementId, {
        id: data.statementId,
        seq,
        proposalId: data.proposalId,
        version: data.version,
        householdId: data.householdId,
        personId: data.personId,
        viaGrantId: data.viaGrantId ?? null,
        position: data.position,
        at: at,
        status: 'active',
        withdrewAt: null,
      });
      return;
    }
    case 'statement-replaced': {
      const old = state.statements.get(data.previousStatementId);
      old.status = 'replaced';
      old.replacedBy = data.statementId;
      return;
    }
    case 'statement-withdrawn': {
      const s = state.statements.get(data.statementId);
      s.status = 'withdrawn';
      s.withdrewAt = at;
      s.withdrawReason = data.reason ?? null;
      return;
    }
    case 'objection-filed': {
      state.objections.set(data.objectionId, {
        id: data.objectionId,
        proposalId: data.proposalId,
        version: data.version,
        householdId: data.householdId,
        personId: data.personId,
        viaGrantId: data.viaGrantId ?? null,
        category: data.category,
        content: data.content,
        at: at,
        afterDeadline: data.afterDeadline ?? false,
      });
      return;
    }
    default:
      // 未知事件类型忽略，保证新旧版本共存时向前兼容
      return;
  }
}
