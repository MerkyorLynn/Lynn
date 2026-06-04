function createWakeLockController({ powerSaveBlocker, logger = console }) {
  const reasons = new Set();
  let blockerId = null;

  function state() {
    return {
      active: blockerId != null && powerSaveBlocker.isStarted(blockerId),
      blockerId,
      reasons: Array.from(reasons),
    };
  }

  function refresh() {
    if (reasons.size > 0) {
      if (blockerId == null || !powerSaveBlocker.isStarted(blockerId)) {
        blockerId = powerSaveBlocker.start("prevent-app-suspension");
        logger.log(`[desktop] wake lock enabled: ${Array.from(reasons).join(", ")}`);
      }
      return state();
    }

    if (blockerId != null) {
      try {
        if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
      } catch (err) {
        logger.warn(`[desktop] wake lock stop failed: ${err?.message || err}`);
      }
      logger.log("[desktop] wake lock released");
      blockerId = null;
    }
    return state();
  }

  function set(reason, active) {
    const key = String(reason || "").trim();
    if (!key) return state();
    if (active) reasons.add(key);
    else reasons.delete(key);
    return refresh();
  }

  function clear() {
    reasons.clear();
    return refresh();
  }

  return { state, set, clear };
}

module.exports = { createWakeLockController };
