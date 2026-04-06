/**
 * project-instructions.js — 项目级指令加载器
 *
 * 从工作目录向上扫描，收集多层级的项目指令文件（类似 Codex AGENTS.md）。
 * 兼容 Lynn / Codex / Claude Code / Cursor 的配置文件格式。
 *
 * 层级合并策略：从根到叶拼接，越具体的层追加在后面（补充而非覆盖）。
 */

import fs from "fs";
import path from "path";
import os from "os";

/** 按优先级排列的项目指令文件名 */
const INSTRUCTION_FILES = [
  ".lynn/AGENTS.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".cursor/rules",
  ".github/copilot-instructions.md",
];

/** 扫描停止边界 */
const STOP_MARKERS = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml"];

/**
 * 从 cwd 向上扫描，收集所有层级的项目指令
 *
 * @param {string} cwd - 当前工作目录
 * @param {object} [opts]
 * @param {number} [opts.maxDepth=10] - 最大向上扫描层数
 * @param {number} [opts.maxTotalBytes=16384] - 合并后最大字节数
 * @returns {{ layers: Array<{ dir: string, file: string, content: string }>, merged: string }}
 */
export function loadProjectInstructions(cwd, opts = {}) {
  const { maxDepth = 10, maxTotalBytes = 16384 } = opts;
  if (!cwd) return { layers: [], merged: "" };

  const homeDir = os.homedir();
  const layers = [];
  let current = path.resolve(cwd);
  let depth = 0;
  let foundRoot = false;

  // 向上扫描直到 home 目录或文件系统根
  while (depth < maxDepth) {
    // 不超过 home 目录
    if (current === homeDir || current === path.dirname(current)) break;

    for (const filename of INSTRUCTION_FILES) {
      const filePath = path.join(current, filename);
      try {
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          if (stat.isFile() && stat.size > 0 && stat.size < 65536) {
            const content = fs.readFileSync(filePath, "utf-8").trim();
            if (content) {
              layers.push({ dir: current, file: filename, content });
            }
          }
        }
      } catch { /* 权限或其他错误，跳过 */ }
    }

    // 检测项目根标记
    if (!foundRoot) {
      for (const marker of STOP_MARKERS) {
        if (fs.existsSync(path.join(current, marker))) {
          foundRoot = true;
          break;
        }
      }
    }

    // 找到项目根后再往上一层就停
    if (foundRoot && depth > 0) break;

    current = path.dirname(current);
    depth++;
  }

  if (layers.length === 0) return { layers: [], merged: "" };

  // 反转：从根到叶（通用 → 具体）
  layers.reverse();

  // 合并，带截断保护
  let merged = "";
  let totalBytes = 0;
  for (const layer of layers) {
    const header = `<!-- Project instructions: ${layer.file} (${path.basename(layer.dir)}) -->\n`;
    const chunk = header + layer.content + "\n\n";
    const chunkBytes = Buffer.byteLength(chunk, "utf-8");
    if (totalBytes + chunkBytes > maxTotalBytes) break;
    merged += chunk;
    totalBytes += chunkBytes;
  }

  return { layers, merged: merged.trim() };
}

/**
 * 为 system prompt 格式化项目指令
 * @param {string} cwd
 * @param {boolean} isZh
 * @returns {string} 可直接注入 system prompt 的文本，空串表示无指令
 */
export function formatProjectInstructions(cwd, isZh) {
  const { merged, layers } = loadProjectInstructions(cwd);
  if (!merged) return "";

  const title = isZh
    ? `# 项目指令\n\n以下是项目级配置文件中的指令（${layers.length} 个层级），请遵循：\n\n`
    : `# Project Instructions\n\nThe following instructions come from project-level config files (${layers.length} layer(s)). Follow them:\n\n`;

  return title + merged;
}
