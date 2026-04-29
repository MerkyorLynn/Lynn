import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

import { createReportTool } from "../lib/tools/report-tool.js";
import { sanitizeHtmlArtifact } from "../desktop/src/react/utils/sanitize.ts";

let dom;
let previousWindow;
let previousDocument;

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function longText(seed) {
  return [
    `${seed}：本段用于模拟 editorial-paper 风格的长报告正文，要求包含明确数据底稿、分析判断、风险约束与结论，不允许只生成标题或空壳页面。`,
    "报告需要在桌面预览中保留完整 HTML 文档结构，包括 head/style/body，以便 iframe srcDoc 能呈现完整版式。",
    "同时，模型提供的章节内容必须被 report tool 转义，artifact renderer 还需要再次执行 sanitizer，防止脚本、事件属性或危险链接进入预览。",
    "这里补足足够长的正文，确保深度报告门槛不会被绕过，也让测试覆盖真实长报告而不是简短会议纪要。",
  ].join("\n");
}

beforeAll(() => {
  previousWindow = globalThis.window;
  previousDocument = globalThis.document;
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
});

afterAll(() => {
  globalThis.window = previousWindow;
  globalThis.document = previousDocument;
  dom?.window?.close();
});

describe("report tool editorial HTML artifacts", () => {
  it("generates a non-empty full-document report that survives artifact sanitization", async () => {
    const outDir = makeTempDir("lynn-report-editorial-");
    try {
      const tool = createReportTool({ getDeskDir: () => outDir });
      const result = await tool.execute("test-call", {
        title: "华丰科技 editorial-paper 深度分析报告",
        tag: "A股研究",
        subtitle: "<img src=x onerror=alert(1)> 不应执行",
        stylePreset: "editorial-paper",
        sections: [
          {
            title: "核心数据底稿",
            type: "metrics",
            metrics: [
              { label: "市值区间", value: "540-620 亿元", direction: "neutral" },
              { label: "短期压力位", value: "130-137 元", direction: "up" },
              { label: "防守区间", value: "500-520 亿元", direction: "down" },
            ],
          },
          {
            title: "基本面与订单",
            type: "text",
            blocks: [
              { heading: "高速互连主线", text: longText("高速线模组与服务器互连需求") },
              { heading: "产能与客户", text: longText("产能利用率、客户认证和订单节奏") },
            ],
          },
          {
            title: "估值与情景推演",
            type: "verdict",
            items: [
              { period: "短期 2-6 周", range: "540-650 亿元", note: longText("短期情绪与估值消化") },
              { period: "中期 3-9 个月", range: "600-750 亿元", note: longText("中期利润兑现与订单验证") },
            ],
          },
          {
            title: "风险提示",
            type: "warning",
            content: `${longText("风险约束")} <script>alert(1)</script> <a href="javascript:alert(2)">bad</a>`,
          },
        ],
      });

      expect(result.details.rejected).toBeUndefined();
      expect(result.details.type).toBe("html");
      expect(result.details.stylePreset).toBe("editorial-paper");
      expect(fs.existsSync(result.details.files[0].filePath)).toBe(true);

      const html = result.details.content;
      expect(html).toMatch(/<!DOCTYPE html>/i);
      expect(html).toContain('name="lynn-report-style"');
      expect(html).toContain('content="editorial-paper"');
      expect(html).toContain('report-editorial-paper');
      expect(html).toContain("<style>");
      expect(html).toContain("Noto Serif SC");
      expect(html).toContain("editorial-paper");
      expect(html).not.toContain("<script>alert");

      const cleaned = sanitizeHtmlArtifact(html);
      expect(cleaned).toMatch(/<html/i);
      expect(cleaned).toMatch(/<head/i);
      expect(cleaned).toContain("<style>");
      expect(cleaned).toContain("华丰科技 editorial-paper 深度分析报告");
      expect(cleaned).not.toContain("<script>");
      const parsed = new JSDOM(cleaned);
      expect([...parsed.window.document.querySelectorAll("a")]
        .some((link) => String(link.getAttribute("href") || "").startsWith("javascript:"))).toBe(false);
      expect([...parsed.window.document.querySelectorAll("img")]
        .some((img) => img.hasAttribute("onerror"))).toBe(false);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("defaults deep reports to the editorial-paper preset", async () => {
    const outDir = makeTempDir("lynn-report-editorial-default-");
    try {
      const tool = createReportTool({ getDeskDir: () => outDir });
      const result = await tool.execute("test-call-default", {
        title: "新能源行业深度研究报告",
        tag: "行业研究",
        subtitle: "验证未显式传入 stylePreset 时的深度报告默认样式",
        sections: [
          {
            title: "数据底稿",
            type: "text",
            content: longText("数据底稿") + "\n" + longText("行业供需"),
          },
          {
            title: "分析判断",
            type: "text",
            content: longText("分析判断") + "\n" + longText("竞争格局"),
          },
          {
            title: "风险与情景",
            type: "warning",
            content: longText("风险情景") + "\n" + longText("估值约束"),
          },
        ],
      });

      expect(result.details.rejected).toBeUndefined();
      expect(result.details.stylePreset).toBe("editorial-paper");
      expect(result.details.content).toContain('content="editorial-paper"');
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
