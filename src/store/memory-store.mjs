import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const COLLECTIONS = [
  'actors',
  'households',
  'plots',
  'delegations',
  'proposals',
  'versions',
  'statements',
  'objections',
];

/**
 * 数据存储：内存集合 + 追加式审计日志。
 * 传入 filePath 时，每次写操作后把全量状态原子落盘（写临时文件再改名），
 * 便于在受控环境中重启恢复；测试默认使用纯内存模式。
 */
export function createStore(options = {}) {
  const filePath = options.filePath ?? null;
  const state = { counters: {}, audit: [] };
  for (const name of COLLECTIONS) {
    state[name] = new Map();
  }

  if (filePath && existsSync(filePath)) {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    state.counters = raw.counters ?? {};
    state.audit = raw.audit ?? [];
    for (const name of COLLECTIONS) {
      for (const row of raw.collections?.[name] ?? []) {
        state[name].set(row.id, row);
      }
    }
  }

  function save() {
    if (!filePath) return;
    const payload = {
      counters: state.counters,
      audit: state.audit,
      collections: Object.fromEntries(COLLECTIONS.map((name) => [name, [...state[name].values()]])),
    };
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, filePath);
  }

  const store = {
    ...Object.fromEntries(COLLECTIONS.map((name) => [name, state[name]])),
    audit: state.audit,
    /** 生成形如 "prop-1" 的确定性编号 */
    nextId(prefix) {
      const n = (state.counters[prefix] ?? 0) + 1;
      state.counters[prefix] = n;
      return `${prefix}-${n}`;
    },
    /** 生成纯数字序号，用于同一刻度下的稳定排序 */
    nextSeq(name) {
      const n = (state.counters[`seq:${name}`] ?? 0) + 1;
      state.counters[`seq:${name}`] = n;
      return n;
    },
    /** 追加审计事件并触发落盘；所有写路径都必须经过这里 */
    record(entry) {
      const event = { seq: state.audit.length + 1, ...entry };
      state.audit.push(event);
      save();
      return event;
    },
    save,
  };

  // 内置一个村集体管理员账号作为引导身份，部署时应替换为受控账号体系。
  if (!store.actors.has('official-root')) {
    store.actors.set('official-root', {
      id: 'official-root',
      name: '村集体管理员',
      role: 'village_official',
      householdId: null,
      createdAt: null,
    });
  }

  return store;
}
