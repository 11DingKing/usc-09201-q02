import http from 'node:http';
import { DomainError } from './domain/errors.mjs';
import { NegotiationService } from './services/negotiation-service.mjs';
import { createStore } from './store/memory-store.mjs';

const MAX_BODY_BYTES = 1_000_000;

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new DomainError('PAYLOAD_TOO_LARGE', '请求体过大', 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new DomainError('BAD_JSON', '请求体不是合法的 JSON', 400));
      }
    });
    request.on('error', reject);
  });
}

function compilePattern(pattern) {
  const parts = pattern.split('/').filter(Boolean);
  return (pathname) => {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length !== parts.length) return null;
    const params = {};
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i].startsWith(':')) {
        params[parts[i].slice(1)] = decodeURIComponent(segments[i]);
      } else if (parts[i] !== segments[i]) {
        return null;
      }
    }
    return params;
  };
}

function defineRoutes() {
  const routes = [
    { method: 'GET', pattern: '/health', auth: false, handler: () => [200, { status: 'ok' }] },
    { method: 'GET', pattern: '/me', handler: (c) => [200, c.service.getMe(c.actor)] },
    // 基础资料（村集体维护）
    { method: 'POST', pattern: '/admin/actors', handler: (c) => [201, c.service.createActor(c.actor, c.body)] },
    { method: 'POST', pattern: '/admin/households', handler: (c) => [201, c.service.createHousehold(c.actor, c.body)] },
    { method: 'POST', pattern: '/admin/plots', handler: (c) => [201, c.service.createPlot(c.actor, c.body)] },
    // 方案与文本版本
    { method: 'GET', pattern: '/proposals', handler: (c) => [200, c.service.listProposals(c.actor)] },
    { method: 'POST', pattern: '/proposals', handler: (c) => [201, c.service.createProposal(c.actor, c.body)] },
    { method: 'GET', pattern: '/proposals/:id', handler: (c) => [200, c.service.getProposal(c.actor, c.params.id)] },
    { method: 'POST', pattern: '/proposals/:id/publish', handler: (c) => [200, c.service.publishProposal(c.actor, c.params.id)] },
    { method: 'POST', pattern: '/proposals/:id/cancel', handler: (c) => [200, c.service.cancelProposal(c.actor, c.params.id)] },
    { method: 'GET', pattern: '/proposals/:id/versions', handler: (c) => [200, c.service.listVersions(c.actor, c.params.id)] },
    { method: 'POST', pattern: '/proposals/:id/versions', handler: (c) => [201, c.service.createVersion(c.actor, c.params.id, c.body)] },
    // 表态（意见）
    {
      method: 'POST',
      pattern: '/proposals/:id/statements',
      handler: (c) => {
        const result = c.service.submitStatement(c.actor, c.params.id, c.body);
        return [result.duplicated ? 200 : 201, result];
      },
    },
    { method: 'GET', pattern: '/proposals/:id/statements', handler: (c) => [200, c.service.listStatements(c.actor, c.params.id)] },
    { method: 'POST', pattern: '/statements/:id/withdraw', handler: (c) => [200, c.service.withdrawStatement(c.actor, c.params.id)] },
    // 异议
    { method: 'POST', pattern: '/proposals/:id/objections', handler: (c) => [201, c.service.raiseObjection(c.actor, c.params.id, c.body)] },
    { method: 'GET', pattern: '/proposals/:id/objections', handler: (c) => [200, c.service.listObjections(c.actor, c.params.id)] },
    { method: 'POST', pattern: '/objections/:id/resolve', handler: (c) => [200, c.service.resolveObjection(c.actor, c.params.id, c.body)] },
    { method: 'POST', pattern: '/objections/:id/withdraw', handler: (c) => [200, c.service.withdrawObjection(c.actor, c.params.id)] },
    // 地块退出、汇总、签署、审计
    { method: 'POST', pattern: '/proposals/:id/exits', handler: (c) => [200, c.service.exitPlots(c.actor, c.params.id, c.body)] },
    { method: 'GET', pattern: '/proposals/:id/summary', handler: (c) => [200, c.service.getSummary(c.actor, c.params.id)] },
    { method: 'POST', pattern: '/proposals/:id/enter-signing', handler: (c) => [200, c.service.enterSigning(c.actor, c.params.id)] },
    { method: 'GET', pattern: '/proposals/:id/audit', handler: (c) => [200, c.service.getAudit(c.actor, c.params.id)] },
    // 委托授权
    { method: 'POST', pattern: '/delegations', handler: (c) => [201, c.service.createDelegation(c.actor, c.body)] },
    { method: 'GET', pattern: '/delegations', handler: (c) => [200, c.service.listDelegations(c.actor)] },
    { method: 'POST', pattern: '/delegations/:id/revoke', handler: (c) => [200, c.service.revokeDelegation(c.actor, c.params.id)] },
  ];
  return routes.map((route) => ({ ...route, match: compilePattern(route.pattern) }));
}

export function createServer(options = {}) {
  const store = options.store ?? createStore({ filePath: options.dataFile ?? process.env.DATA_FILE ?? null });
  const clock = options.clock ?? (() => Date.now());
  const service = new NegotiationService(store, clock);
  const routes = defineRoutes();

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const pathname = url.pathname;

      let matched = null;
      for (const route of routes) {
        if (route.method !== request.method) continue;
        const params = route.match(pathname);
        if (params) {
          matched = { route, params };
          break;
        }
      }
      if (!matched) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: '资源不存在' } });
        return;
      }

      const { route, params } = matched;
      let actor = null;
      if (route.auth !== false) {
        const actorId = request.headers['x-actor-id'];
        actor = typeof actorId === 'string' ? store.actors.get(actorId) : null;
        if (!actor) {
          sendJson(response, 401, { error: { code: 'UNAUTHENTICATED', message: '缺少有效的身份标识（x-actor-id）' } });
          return;
        }
      }

      const body = request.method === 'GET' ? {} : await readBody(request);
      const [status, payload] = route.handler({ service, actor, body, params });
      sendJson(response, status, payload);
    } catch (error) {
      if (error instanceof DomainError) {
        const body = { error: { code: error.code, message: error.message } };
        if (error.details !== undefined) {
          body.error.details = error.details;
        }
        sendJson(response, error.httpStatus, body);
        return;
      }
      console.error('未处理的服务异常:', error);
      sendJson(response, 500, { error: { code: 'INTERNAL', message: '服务内部错误' } });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`服务已启动：http://0.0.0.0:${port}`);
  });
}
