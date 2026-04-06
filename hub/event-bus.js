/**
 * EventBus — 统一事件总线
 *
 * 通过 engine.setEventBus() 注入，Engine 的 _emitEvent / subscribe 委托到这里。
 * 支持带过滤的订阅：按 sessionPath / event type 过滤。
 * 支持 request/handle 请求响应模式，供 plugin 间通信使用。
 */

export class BusNoHandlerError extends Error {
  constructor(type) {
    super(`No handler registered for "${type}"`);
    this.name = "BusNoHandlerError";
    this.type = type;
  }
}

export class BusTimeoutError extends Error {
  constructor(type, ms) {
    super(`Request "${type}" timeout after ${ms}ms`);
    this.name = "BusTimeoutError";
    this.type = type;
  }
}

export class EventBus {
  constructor() {
    /** @type {Map<number, {callback: Function, filter: object}>} */
    this._subscribers = new Map();
    this._nextId = 0;
    /** @type {Map<string, Function[]>} */
    this._handlers = new Map();
  }

  /**
   * 订阅事件
   * @param {Function} callback  (event, sessionPath) => void
   * @param {object} [filter]
   * @param {string} [filter.sessionPath]  只接收该 session 的事件
   * @param {string[]} [filter.types]      只接收这些 event.type
   * @returns {Function} unsubscribe
   */
  subscribe(callback, filter = {}) {
    const id = ++this._nextId;
    this._subscribers.set(id, { callback, filter });
    return () => this._subscribers.delete(id);
  }

  /**
   * 发射事件
   * @param {object} event        事件对象，需有 type 字段
   * @param {string|null} sessionPath  关联的 session 路径
   */
  emit(event, sessionPath) {
    for (const [, { callback, filter }] of this._subscribers) {
      if (filter.sessionPath && filter.sessionPath !== sessionPath) continue;
      if (filter.types && !filter.types.includes(event.type)) continue;
      try { callback(event, sessionPath); } catch (err) {
        console.error("[EventBus] subscriber error:", err.message);
      }
    }
  }

  /** 清理所有订阅和 handler */
  clear() {
    this._subscribers.clear();
    this._handlers.clear();
  }

  static SKIP = Symbol("BUS_SKIP");

  /**
   * 注册请求处理器
   * @param {string} type           请求类型
   * @param {Function} handler      async (payload) => result | EventBus.SKIP
   * @returns {Function} unhandle
   */
  handle(type, handler) {
    if (!this._handlers.has(type)) this._handlers.set(type, []);
    this._handlers.get(type).push(handler);
    return () => {
      const arr = this._handlers.get(type);
      if (!arr) return;
      const idx = arr.indexOf(handler);
      if (idx !== -1) arr.splice(idx, 1);
      if (arr.length === 0) this._handlers.delete(type);
    };
  }

  /**
   * 发起请求，等待第一个不返回 SKIP 的 handler 响应
   * @param {string} type
   * @param {object} payload
   * @param {object} [options]
   * @param {number} [options.timeout=30000]
   * @returns {Promise<any>}
   */
  async request(type, payload, options = {}) {
    const handlers = this._handlers.get(type);
    if (!handlers || handlers.length === 0) throw new BusNoHandlerError(type);
    const timeout = options.timeout ?? 30000;

    let timerId;
    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new BusTimeoutError(type, timeout)), timeout);
    });

    try {
      return await Promise.race([
        this._tryHandlers(type, handlers, payload),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timerId);
    }
  }

  async _tryHandlers(type, handlers, payload) {
    for (const h of [...handlers]) {
      const result = await h(payload);
      if (result !== EventBus.SKIP) return result;
    }
    throw new BusNoHandlerError(type);
  }

  /**
   * 检查某个 type 是否有已注册的 handler
   * @param {string} type
   * @returns {boolean}
   */
  hasHandler(type) {
    const arr = this._handlers.get(type);
    return arr != null && arr.length > 0;
  }
}
