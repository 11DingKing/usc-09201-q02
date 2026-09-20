/**
 * HTTP 适配层：把 REST 请求映射为命令/查询。
 * 身份经 x-actor-role / x-actor-id 头传入（演示用；真实部署应由认证中间件签发）。
 * 所有命令支持 Idempotency-Key 头防重。
 */
import { DomainError } from '../domain/errors.mjs';

const ROUTES = [
  ['POST', /^\/api\/companies$/, 'register-company'],
  ['POST', /^\/api\/households$/, 'register-household'],
  ['POST', /^\/api\/plots$/, 'register-plot'],
  ['POST', /^\/api\/proposals$/, 'create-proposal'],
  ['POST', /^\/api\/proposals\/([^/]+)\/revisions$/, 'revise-proposal'],
  ['POST', /^\/api\/proposals\/([^/]+)\/deadline-extensions$/, 'extend-deadline'],
  ['POST', /^\/api\/grants$/, 'issue-grant'],
  ['POST', /^\/api\/grants\/([^/]+)\/revocations$/, 'revoke-grant'],
  ['POST', /^\/api\/proposals\/([^/]+)\/plot-exits$/, 'file-plot-exit'],
  ['POST', /^\/api\/proposals\/([^/]+)\/statements$/, 'make-statement'],
  ['POST', /^\/api\/proposals\/([^/]+)\/withdrawals$/, 'withdraw-statement'],
  ['POST', /^\/api\/proposals\/([^/]+)\/objections$/, 'file-objection'],
  ['POST', /^\/api\/proposals\/([^/]+)\/finalization$/, 'finalize-proposal'],
  ['GET', /^\/api\/proposals\/([^/]+)$/, 'view-proposal'],
  ['GET', /^\/api\/proposals\/([^/]+)\/group-tally$/, 'view-group-tally'],
  ['GET', /^\/api\/proposals\/([^/]+)\/objections$/, 'view-objections'],
  ['GET', /^\/api\/households\/([^/]+)$/, 'view-household'],
  ['GET', /^\/api\/events$/, 'view-events'],
];

function readContext(request) {
  const role = request.headers['x-actor-role'];
  const id = request.headers['x-actor-id'];
  const ctx = { role: role ?? 'public' };
  if (role === 'company') ctx.companyId = id;
  if (role === 'person') ctx.personId = id;
  return ctx;
}

export function createRouter(service) {
  return async function router(request, response) {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') {
      return json(response, 200, { status: 'ok' });
    }

    const match = ROUTES.find(([method, pattern]) => request.method === method && pattern.test(url.pathname));
    if (!match) {
      return json(response, 404, { error: 'not_found' });
    }
    const [, pattern, action] = match;
    const captures = url.pathname.match(pattern).slice(1);

    let body = {};
    if (request.method === 'POST') {
      try {
        const raw = await readBody(request);
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return json(response, 400, { error: 'invalid_json' });
      }
    }

    const ctx = readContext(request);
    const idempotencyKey = request.headers['idempotency-key'];

    try {
      switch (action) {
        // 登记类
        case 'register-company':
          return json(response, 201, await run(service, {
            type: 'register-company', ctx, idempotencyKey,
            companyId: body.companyId, name: body.name,
          }));
        case 'register-household':
          return json(response, 201, await run(service, {
            type: 'register-household', ctx, idempotencyKey,
            householdId: body.householdId, name: body.name, group: body.group, members: body.members,
          }));
        case 'register-plot':
          return json(response, 201, await run(service, {
            type: 'register-plot', ctx, idempotencyKey,
            plotId: body.plotId, householdId: body.householdId, group: body.group,
          }));

        // 提案
        case 'create-proposal':
          return json(response, 201, await run(service, {
            type: 'create-proposal', ctx, idempotencyKey,
            proposalId: body.proposalId, scopePlotIds: body.scopePlotIds,
            threshold: body.threshold, deadline: body.deadline, terms: body.terms,
          }));
        case 'revise-proposal':
          return json(response, 201, await run(service, {
            type: 'revise-proposal', ctx, idempotencyKey,
            proposalId: captures[0], terms: body.terms,
          }));
        case 'extend-deadline':
          return json(response, 200, await run(service, {
            type: 'extend-deadline', ctx, idempotencyKey,
            proposalId: captures[0], newDeadline: body.newDeadline,
          }));

        // 委托
        case 'issue-grant':
          return json(response, 201, await run(service, {
            type: 'issue-grant', ctx, idempotencyKey,
            grantId: body.grantId, householdId: body.householdId,
            granterPersonId: body.granterPersonId, attorneyPersonId: body.attorneyPersonId,
            actions: body.actions, plotScope: body.plotScope, expiresAt: body.expiresAt,
          }));
        case 'revoke-grant':
          return json(response, 200, await run(service, {
            type: 'revoke-grant', ctx, idempotencyKey,
            grantId: captures[0], reason: body.reason,
          }));

        // 地块退出 / 表态 / 撤回 / 异议
        case 'file-plot-exit':
          return json(response, 201, await run(service, {
            type: 'file-plot-exit', ctx, idempotencyKey,
            proposalId: captures[0], plotId: body.plotId,
            actorPersonId: body.actorPersonId ?? ctx.personId, reason: body.reason,
          }));
        case 'make-statement':
          return json(response, 201, await run(service, {
            type: 'make-statement', ctx, idempotencyKey,
            proposalId: captures[0], householdId: body.householdId,
            actorPersonId: body.actorPersonId ?? ctx.personId,
            position: body.position, statementId: body.statementId,
          }));
        case 'withdraw-statement':
          return json(response, 200, await run(service, {
            type: 'withdraw-statement', ctx, idempotencyKey,
            proposalId: captures[0], householdId: body.householdId,
            actorPersonId: body.actorPersonId ?? ctx.personId, reason: body.reason,
          }));
        case 'file-objection':
          return json(response, 201, await run(service, {
            type: 'file-objection', ctx, idempotencyKey,
            proposalId: captures[0], householdId: body.householdId,
            actorPersonId: body.actorPersonId ?? ctx.personId,
            category: body.category, content: body.content, objectionId: body.objectionId,
          }));
        case 'finalize-proposal':
          return json(response, 200, await run(service, {
            type: 'finalize-proposal', ctx, idempotencyKey,
            proposalId: captures[0], textRef: body.textRef,
          }));

        // 查询
        case 'view-proposal':
          return json(response, 200, service.proposalView(captures[0], ctx));
        case 'view-group-tally':
          return json(response, 200, service.groupTallyView(captures[0], ctx));
        case 'view-objections':
          return json(response, 200, service.objectionsView(captures[0], ctx));
        case 'view-household':
          return json(response, 200, service.householdView(captures[0], ctx));
        case 'view-events':
          return json(response, 200, service.eventLog(ctx, {
            fromSeq: Number(url.searchParams.get('fromSeq') ?? 0),
          }));
        default:
          return json(response, 404, { error: 'not_found' });
      }
    } catch (error) {
      if (error instanceof DomainError) {
        return json(response, error.status, {
          error: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      console.error(error);
      return json(response, 500, { error: 'internal_error' });
    }
  };
}

function run(service, command) {
  return service.dispatch(command);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('body_too_large'));
    });
    request.on('end', () => resolve(data));
    request.on('error', reject);
  });
}

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}
