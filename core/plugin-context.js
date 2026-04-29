import fs from "fs";
import path from "path";

/**
 * Create a PluginContext for a plugin.
 * @param {{ pluginId: string, pluginDir: string, dataDir: string, bus: object, engine?: object, disposables?: Function[] }} opts
 */
export function createPluginContext({ pluginId, pluginDir, dataDir, bus, engine = null, disposables = null }) {
  const configPath = path.join(dataDir, "config.json");

  const config = {
    get(key) {
      try {
        const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        return key ? data[key] : data;
      } catch {
        return key ? undefined : {};
      }
    },
    set(key, value) {
      fs.mkdirSync(dataDir, { recursive: true });
      const data = config.get() || {};
      data[key] = value;
      fs.writeFileSync(configPath, JSON.stringify(data, null, 2), "utf-8");
    },
  };

  const prefix = `[plugin:${pluginId}]`;
  const log = {
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    debug: (...args) => console.debug(prefix, ...args),
  };

  const trackDisposable = (disposable) => {
    if (typeof disposable === "function" && Array.isArray(disposables)) {
      disposables.push(disposable);
    }
    return disposable;
  };

  const subscribe = (...args) => {
    if (!bus || typeof bus.subscribe !== "function") return () => {};
    return trackDisposable(bus.subscribe(...args));
  };
  const handle = (...args) => {
    if (!bus || typeof bus.handle !== "function") return () => {};
    return trackDisposable(bus.handle(...args));
  };

  return { pluginId, pluginDir, dataDir, bus, engine, config, log, subscribe, handle };
}
