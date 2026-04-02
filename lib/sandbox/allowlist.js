/**
 * allowlist.js — 持久化安全白名单
 *
 * 用户在授权模式下勾选「以后都允许」后，将操作存入白名单。
 * 下次同类操作直接放行，不再弹确认。
 *
 * 存储位置：~/.lynn/security-allowlist.json
 * 结构：{ "elevated_command:sudo": true, "path_write:/some/path": true }
 */

import fs from "fs";
import path from "path";

export class SecurityAllowlist {
  /**
   * @param {string} lynnHome  ~/.lynn 目录
   */
  constructor(lynnHome) {
    this._path = path.join(lynnHome, "security-allowlist.json");
    this._data = this._load();
  }

  /** 组合 key */
  static _key(category, identifier) {
    return `${category}:${identifier}`;
  }

  /** 检查是否在白名单中 */
  check(category, identifier) {
    return !!this._data[SecurityAllowlist._key(category, identifier)];
  }

  /** 添加到白名单 */
  add(category, identifier) {
    this._data[SecurityAllowlist._key(category, identifier)] = true;
    this._save();
  }

  /** 从白名单移除 */
  remove(category, identifier) {
    delete this._data[SecurityAllowlist._key(category, identifier)];
    this._save();
  }

  /** 清空白名单 */
  clear() {
    this._data = {};
    this._save();
  }

  /** 列出所有白名单条目（供设置页展示） */
  list() {
    return Object.keys(this._data).map(key => {
      const idx = key.indexOf(":");
      return {
        key,
        category: key.slice(0, idx),
        identifier: key.slice(idx + 1),
      };
    });
  }

  /** 删除指定的完整 key */
  removeByKey(key) {
    delete this._data[key];
    this._save();
  }

  /** @private */
  _load() {
    try {
      return JSON.parse(fs.readFileSync(this._path, "utf-8"));
    } catch {
      return {};
    }
  }

  /** @private */
  _save() {
    try {
      fs.mkdirSync(path.dirname(this._path), { recursive: true });
      const tmp = this._path + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2) + "\n", "utf-8");
      fs.renameSync(tmp, this._path);
    } catch (err) {
      console.error("[allowlist] save failed:", err.message);
    }
  }
}
