/**
 * 事件存储：只追加，不修改、不删除。
 * seq 全局单调递增，是一切“先后争议”的最终裁决依据
 * （重复表态、并发改价、撤回与表态交错等）。
 */
export class EventStore {
  #events = [];
  #seq = 0;

  append(at, type, data = {}) {
    this.#seq += 1;
    const event = { seq: this.#seq, at, type, data };
    this.#events.push(event);
    return event;
  }

  get events() {
    return this.#events;
  }

  reset() {
    this.#events = [];
    this.#seq = 0;
  }
}
