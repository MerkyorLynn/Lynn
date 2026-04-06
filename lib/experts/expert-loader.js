/**
 * ExpertLoader — 从磁盘加载专家预设
 *
 * 扫描 lib/experts/presets/ 目录，读取每个专家的 expert.yaml。
 * 返回标准化的专家配置对象数组。
 */
import fs from "fs";
import path from "path";
import YAML from "js-yaml";

/**
 * 扫描预设目录，返回所有专家预设配置
 * @param {string} presetsDir - 预设目录路径（如 lib/experts/presets/）
 * @returns {Array<object>} - 专家预设数组
 */
export function loadPresets(presetsDir) {
  if (!fs.existsSync(presetsDir)) return [];

  const entries = fs.readdirSync(presetsDir, { withFileTypes: true });
  const presets = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const expertDir = path.join(presetsDir, entry.name);
    const expertYamlPath = path.join(expertDir, "expert.yaml");

    if (!fs.existsSync(expertYamlPath)) continue;

    try {
      const raw = fs.readFileSync(expertYamlPath, "utf-8");
      const config = YAML.load(raw);

      if (!config?.slug) {
        console.warn(`[expert-loader] 跳过 ${entry.name}：缺少 slug`);
        continue;
      }

      // 读取 identity.md（可选）
      let identity = "";
      try {
        identity = fs.readFileSync(path.join(expertDir, "identity.md"), "utf-8");
      } catch {}

      // 读取 ishiki.md（可选）
      let ishiki = "";
      try {
        ishiki = fs.readFileSync(path.join(expertDir, "ishiki.md"), "utf-8");
      } catch {}

      // 读取专家技能目录
      const skillNames = [];
      const skillsDir = path.join(expertDir, "skills");
      if (fs.existsSync(skillsDir)) {
        try {
          const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
          for (const se of skillEntries) {
            if (se.isDirectory() && fs.existsSync(path.join(skillsDir, se.name, "SKILL.md"))) {
              skillNames.push(se.name);
            }
          }
        } catch {}
      }

      presets.push({
        slug: config.slug,
        name: config.name || { en: entry.name },
        icon: config.icon || "🤖",
        category: config.category || "general",
        tier: "expert",
        model_binding: config.model_binding || {
          preferred: "claude-sonnet-4",
          fallback: "claude-sonnet-4",
        },
        credit_cost: config.credit_cost || {
          per_session: 20,
          per_extra_round: 5,
        },
        skills: config.skills || skillNames,
        description: config.description || {},
        _dir: expertDir,
        _identity: identity,
        _ishiki: ishiki,
      });
    } catch (err) {
      console.warn(`[expert-loader] 加载 ${entry.name} 失败: ${err.message}`);
    }
  }

  return presets;
}

/**
 * 根据 slug 加载单个专家预设
 * @param {string} presetsDir
 * @param {string} slug
 * @returns {object|null}
 */
export function loadPresetBySlug(presetsDir, slug) {
  const all = loadPresets(presetsDir);
  return all.find(p => p.slug === slug) || null;
}
