/**
 * ProviderRegistry — credential read + model CRUD 单元测试
 *
 * 覆盖新增方法：getCredentials, getProviderModels, getAllProvidersRaw,
 * addModel, removeModel, saveProvider, removeProvider
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { ProviderRegistry } from "../core/provider-registry.js";

const tmpDir = path.join(os.tmpdir(), "hana-test-pr-crud-" + Date.now());

function writeAddedModels(providers) {
  const ymlPath = path.join(tmpDir, "added-models.yaml");
  fs.writeFileSync(ymlPath, YAML.dump({ providers }), "utf-8");
}

function readAddedModels() {
  const ymlPath = path.join(tmpDir, "added-models.yaml");
  const raw = YAML.load(fs.readFileSync(ymlPath, "utf-8"));
  return raw?.providers || {};
}

/** 创建一个 registry，注册一个测试插件 */
function makeRegistry(pluginOverrides = {}) {
  const reg = new ProviderRegistry(tmpDir);
  // 清除所有内置插件，只留测试用的
  reg._plugins.clear();
  reg._entries.clear();

  const testPlugin = {
    id: "test-provider",
    displayName: "Test Provider",
    authType: "api-key",
    defaultBaseUrl: "https://api.test.com/v1",
    defaultApi: "openai-completions",
    ...pluginOverrides,
  };
  reg._plugins.set(testPlugin.id, testPlugin);
  return reg;
}

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── getCredentials ───────────────────────────────────────────────────────────

describe("getCredentials", () => {
  it("返回已配置 provider 的 apiKey/baseUrl/api", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-test-123",
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
      },
    });
    const reg = makeRegistry();
    const creds = reg.getCredentials("test-provider");
    expect(creds).toEqual({
      apiKey: "sk-test-123",
      baseUrl: "https://custom.api.com/v1",
      api: "openai-completions",
    });
  });

  it("未配置的 provider 返回 null", () => {
    writeAddedModels({});
    const reg = makeRegistry();
    const creds = reg.getCredentials("nonexistent");
    expect(creds).toBeNull();
  });

  it("added-models.yaml 未设置 baseUrl/api 时，从插件默认值回退", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-fallback",
      },
    });
    const reg = makeRegistry();
    const creds = reg.getCredentials("test-provider");
    expect(creds.apiKey).toBe("sk-fallback");
    expect(creds.baseUrl).toBe("https://api.test.com/v1");
    expect(creds.api).toBe("openai-completions");
  });
});

// ── getProviderModels ────────────────────────────────────────────────────────

describe("getProviderModels", () => {
  it("返回字符串格式的模型 ID 列表", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: ["model-a", "model-b", "model-c"],
      },
    });
    const reg = makeRegistry();
    const models = reg.getProviderModels("test-provider");
    expect(models).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("处理对象格式的模型条目（提取 id）", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: [
          "model-a",
          { id: "model-b", name: "Model B", context: 128000 },
          "model-c",
        ],
      },
    });
    const reg = makeRegistry();
    const models = reg.getProviderModels("test-provider");
    expect(models).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("未配置 models 时返回空数组", () => {
    writeAddedModels({
      "test-provider": { api_key: "sk-x" },
    });
    const reg = makeRegistry();
    const models = reg.getProviderModels("test-provider");
    expect(models).toEqual([]);
  });

  it("不存在的 provider 返回空数组", () => {
    writeAddedModels({});
    const reg = makeRegistry();
    const models = reg.getProviderModels("nonexistent");
    expect(models).toEqual([]);
  });
});

// ── getAllProvidersRaw ────────────────────────────────────────────────────────

describe("getAllProvidersRaw", () => {
  it("返回 added-models.yaml 原始数据", () => {
    const data = {
      "test-provider": {
        api_key: "sk-x",
        base_url: "https://api.test.com/v1",
        models: ["model-a"],
      },
      "other-provider": {
        api_key: "sk-y",
      },
    };
    writeAddedModels(data);
    const reg = makeRegistry();
    const raw = reg.getAllProvidersRaw();
    expect(raw["test-provider"].api_key).toBe("sk-x");
    expect(raw["other-provider"].api_key).toBe("sk-y");
    expect(raw["test-provider"].models).toEqual(["model-a"]);
  });

  it("added-models.yaml 不存在时返回空对象", () => {
    // 不写文件
    const reg = makeRegistry();
    const raw = reg.getAllProvidersRaw();
    expect(raw).toEqual({});
  });
});

// ── addModel ─────────────────────────────────────────────────────────────────

describe("addModel", () => {
  it("向已有 provider 添加模型并持久化", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: ["model-a"],
      },
    });
    const reg = makeRegistry();
    reg.addModel("test-provider", "model-b");

    // 验证内存
    const models = reg.getProviderModels("test-provider");
    expect(models).toContain("model-b");

    // 验证持久化
    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toContain("model-b");
  });

  it("不会添加重复模型", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: ["model-a"],
      },
    });
    const reg = makeRegistry();
    reg.addModel("test-provider", "model-a");

    const persisted = readAddedModels();
    const count = persisted["test-provider"].models.filter(
      (m) => m === "model-a",
    ).length;
    expect(count).toBe(1);
  });

  it("provider 没有 models 字段时创建之", () => {
    writeAddedModels({
      "test-provider": { api_key: "sk-x" },
    });
    const reg = makeRegistry();
    reg.addModel("test-provider", "new-model");

    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toEqual(["new-model"]);
  });

  it("支持添加对象格式的模型", () => {
    writeAddedModels({
      "test-provider": { api_key: "sk-x", models: [] },
    });
    const reg = makeRegistry();
    reg.addModel("test-provider", { id: "model-obj", name: "Model Obj", context: 32000 });

    const persisted = readAddedModels();
    const entry = persisted["test-provider"].models.find(
      (m) => (typeof m === "object" ? m.id : m) === "model-obj",
    );
    expect(entry).toBeTruthy();
  });

  it("对象格式模型不与同 id 的已有条目重复", () => {
    writeAddedModels({
      "test-provider": { api_key: "sk-x", models: ["model-obj"] },
    });
    const reg = makeRegistry();
    reg.addModel("test-provider", { id: "model-obj", name: "Model Obj" });

    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toHaveLength(1);
  });
});

// ── removeModel ──────────────────────────────────────────────────────────────

describe("removeModel", () => {
  it("移除模型并持久化", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: ["model-a", "model-b", "model-c"],
      },
    });
    const reg = makeRegistry();
    reg.removeModel("test-provider", "model-b");

    const models = reg.getProviderModels("test-provider");
    expect(models).toEqual(["model-a", "model-c"]);

    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toEqual(["model-a", "model-c"]);
  });

  it("移除对象格式的模型条目（按 id 匹配）", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: [
          "model-a",
          { id: "model-b", name: "Model B" },
        ],
      },
    });
    const reg = makeRegistry();
    reg.removeModel("test-provider", "model-b");

    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toEqual(["model-a"]);
  });

  it("移除不存在的模型不会报错", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: ["model-a"],
      },
    });
    const reg = makeRegistry();
    expect(() => reg.removeModel("test-provider", "nonexistent")).not.toThrow();
    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toEqual(["model-a"]);
  });
});

// ── saveProvider ─────────────────────────────────────────────────────────────

describe("saveProvider", () => {
  it("创建新的 provider 条目", () => {
    writeAddedModels({});
    const reg = makeRegistry();
    reg.saveProvider("new-provider", {
      api_key: "sk-new",
      base_url: "https://new.api.com/v1",
      api: "openai-completions",
    });

    const persisted = readAddedModels();
    expect(persisted["new-provider"]).toBeDefined();
    expect(typeof persisted["new-provider"].api_key).toBe("string");
    expect(persisted["new-provider"].api_key.startsWith("enc:")).toBe(true);
    expect(reg.getCredentials("new-provider")).toEqual({
      apiKey: "sk-new",
      baseUrl: "https://new.api.com/v1",
      api: "openai-completions",
    });
  });

  it("更新已有 provider 的配置（合并）", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-old",
        base_url: "https://old.api.com/v1",
        models: ["model-a"],
      },
    });
    const reg = makeRegistry();
    reg.saveProvider("test-provider", {
      api_key: "sk-new",
      base_url: "https://new.api.com/v1",
    });

    const persisted = readAddedModels();
    expect(typeof persisted["test-provider"].api_key).toBe("string");
    expect(persisted["test-provider"].api_key.startsWith("enc:")).toBe(true);
    expect(persisted["test-provider"].base_url).toBe("https://new.api.com/v1");
    // 原有的 models 保留
    expect(persisted["test-provider"].models).toEqual(["model-a"]);
    expect(reg.getCredentials("test-provider")).toEqual({
      apiKey: "sk-new",
      baseUrl: "https://new.api.com/v1",
      api: "openai-completions",
    });
  });

  it("写入后缓存失效，下次 get() 反映新值", () => {
    writeAddedModels({});
    const reg = makeRegistry();
    reg.saveProvider("test-provider", {
      api_key: "sk-saved",
      base_url: "https://saved.api.com/v1",
    });
    // 触发 reload
    const entry = reg.get("test-provider");
    expect(entry).toBeTruthy();
    expect(entry.baseUrl).toBe("https://saved.api.com/v1");
  });
});

// ── removeProvider ───────────────────────────────────────────────────────────

describe("removeProvider", () => {
  it("删除 provider 条目", () => {
    writeAddedModels({
      "test-provider": { api_key: "sk-x" },
      "keep-me": { api_key: "sk-y" },
    });
    const reg = makeRegistry();
    reg.removeProvider("test-provider");

    const persisted = readAddedModels();
    expect(persisted["test-provider"]).toBeUndefined();
    expect(persisted["keep-me"]).toBeDefined();
  });

  it("删除不存在的 provider 不报错", () => {
    writeAddedModels({});
    const reg = makeRegistry();
    expect(() => reg.removeProvider("nonexistent")).not.toThrow();
  });
});
