/**
 * 时间统一从时钟取，生产用系统时钟，测试用手动时钟，
 * 保证“到期 / 截止前撤回”等判定可重复、可确定。
 */
export class SystemClock {
  nowISO() {
    return new Date().toISOString();
  }
}

export class ManualClock {
  constructor(initial = '2026-01-10T08:00:00.000Z') {
    this.#time = Date.parse(initial);
  }

  #time;

  nowISO() {
    return new Date(this.#time).toISOString();
  }

  advance(ms) {
    this.#time += ms;
    return this.nowISO();
  }

  setTo(iso) {
    this.#time = Date.parse(iso);
    return this.nowISO();
  }
}
