// Brain v2 · tool-exec helpers
// LRU cache + Promise.allSettled with overall budget

export function makeLruCache(maxSize, ttlMs) {
  const m = new Map();
  return {
    get(k) {
      const v = m.get(k);
      if (!v) return null;
      if (Date.now() - v.ts > ttlMs) { m.delete(k); return null; }
      m.delete(k); m.set(k, v);
      return v.val;
    },
    set(k, val) {
      if (m.has(k)) m.delete(k);
      m.set(k, { val, ts: Date.now() });
      if (m.size > maxSize) m.delete(m.keys().next().value);
    },
    size() { return m.size; },
    clear() { m.clear(); },
  };
}

// Wrap a promise with a timeout that rejects with a timeout error.
export function withTimeout(promise, ms, label = 'racer') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timeout ' + ms + 'ms')), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

// Run racers within `budgetMs`. Returns array of { source, ok, value | error }.
// As soon as `minSuccess` racers succeed we wait a tiny settle window for other
// already-fast racers, then return; callers that pass an AbortController should
// abort laggards after this resolves.
export async function aggregateAllSettled(racers, budgetMs, { minSuccess = 1, settleWindowMs = 25 } = {}) {
  const list = Array.isArray(racers) ? racers : [];
  if (!list.length) return [];

  return new Promise((resolve) => {
    let settled = false;
    let pending = list.length;
    let success = 0;
    const results = new Array(list.length);
    let settleTimer = null;

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      resolve(results.filter(Boolean));
    }

    function scheduleFinish() {
      if (settled || settleTimer) return;
      if (settleWindowMs <= 0) {
        finish();
        return;
      }
      settleTimer = setTimeout(finish, settleWindowMs);
    }

    const timer = setTimeout(() => {
      if (settled) return;
      for (let i = 0; i < list.length; i++) {
        if (!results[i]) {
          results[i] = {
            source: list[i].source,
            ok: false,
            error: list[i].source + ' timeout ' + budgetMs + 'ms',
          };
        }
      }
      finish();
    }, budgetMs);

    list.forEach(({ source, fn }, index) => {
      Promise.resolve()
        .then(() => fn())
        .then(
          (value) => ({ source, ok: true, value }),
          (error) => ({ source, ok: false, error: error.message || String(error) }),
        )
        .then((entry) => {
          if (settled) return;
          results[index] = entry;
          pending--;
          if (entry.ok) success++;
          if (pending === 0) finish();
          else if (success >= minSuccess) scheduleFinish();
        });
    });
  });
}
