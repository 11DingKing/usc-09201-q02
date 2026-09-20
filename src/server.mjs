import http from 'node:http';
import { ManualClock, SystemClock } from './domain/clock.mjs';
import { createRouter } from './http/router.mjs';
import { EventStore } from './domain/store.mjs';
import { NegotiationService } from './domain/service.mjs';

export function createServer({ clock, store } = {}) {
  const eventStore = store ?? new EventStore();
  const time = clock ?? new SystemClock();
  const service = new NegotiationService(eventStore, time);
  const router = createRouter(service);
  const server = http.createServer(router);
  // 测试与装配需要直接访问领域服务/存储/时钟
  server.service = service;
  server.store = eventStore;
  server.clock = time;
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`服务已启动：http://0.0.0.0:${port}`);
  });
}
