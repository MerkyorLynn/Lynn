import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";

import { createPosterTool } from "../lib/tools/poster-tool.js";
import { createPptxTool } from "../lib/tools/pptx-tool.js";
import { createReportTool } from "../lib/tools/report-tool.js";
import { createDocxTool } from "../lib/tools/docx-tool.js";
import { createStockResearchTool, normalizeStockResearchTsCode } from "../lib/tools/stock-research-tool.js";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("generated document tools", () => {
  it("creates a readable DOCX attachment from markdown-like report text", async () => {
    const outDir = makeTempDir("lynn-docx-tool-");
    try {
      const tool = createDocxTool({ getDeskDir: () => outDir });
      const result = await tool.execute("test-call", {
        title: "中老年互联网内容生态调研报告",
        content: [
          "# 中老年互联网内容生态调研报告",
          "",
          "## 核心结论",
          "- 红松、糖豆的核心受众集中在退休前后和退休后的兴趣学习人群。",
          "- 美篇等 App 覆盖更广的图文记录、家庭分享和兴趣社群用户。",
          "- 三类产品的交集是有闲暇、愿意学习或表达、希望获得陪伴感的中老年用户。",
          "- 差异在于红松偏课程与兴趣学习，糖豆偏广场舞和视频跟练，美篇偏图文记录与熟人传播。",
          "",
          "## 受众拆解",
          "红松更适合覆盖退休前后、有学习意愿、愿意为课程和社群服务付费的人群。糖豆更集中在广场舞、健身操、短视频跟练等强场景，用户通常重视简单易学、可复制传播和同伴互动。美篇覆盖的年龄层更宽，典型用户包括摄影、旅行、家庭记录、诗歌散文和兴趣社群创作者。",
          "从年龄上看，50-60 岁用户通常仍保留较强的学习和表达动机，愿意尝试课程、模板和轻量工具；60-70 岁用户更重视健康、兴趣陪伴和同城社交；70 岁以上用户更依赖低门槛内容、家人转发和熟人推荐。不同平台应把这些差异转化为栏目、活动和付费权益的分层设计。",
          "",
          "## 内容传播机会",
          "面向泛老年人群的互联网内容需要同时满足安全感、低学习成本和可分享性。适合传播的内容形态包括健康知识、兴趣教程、家庭关系、退休生活规划、地方文化、短视频模板、图文故事和可直接转发给亲友的轻量素材。",
          "更容易起量的内容通常有三个特征：第一，能够被一眼看懂，标题和封面直接说明收益；第二，能够被转发给亲友，具备情绪价值或实用价值；第三，能够被低成本复刻，例如跟练动作、图文模板、节日祝福、养生提醒、旅游攻略和家庭关系建议。",
          "",
          "## 交集与差异",
          "共同点是用户都需要陪伴、表达和被看见；不同点是红松更偏知识服务，糖豆更偏动作和娱乐，美篇更偏创作与沉淀。产品设计上可以用低门槛任务、模板化创作、社群激励和轻付费权益连接这些需求。",
          "",
          "## 建议",
          "围绕健康、兴趣、家庭关系和轻社交设计内容栏目。",
          "一方面用可复制的课程、模板和活动降低生产门槛，另一方面通过社群互评、达人共创和家庭分享提高持续传播。商业化应避免强推高价付费，更适合采用小额解锁、会员权益、活动服务和内容工具包组合。",
        ].join("\n"),
      });

      const filePath = result.details.files[0].filePath;
      expect(filePath.endsWith(".docx")).toBe(true);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.statSync(filePath).size).toBeGreaterThan(1000);

      const mammoth = (await import("mammoth")).default;
      const extracted = await mammoth.extractRawText({ path: filePath });
      expect(extracted.value).toContain("中老年互联网内容生态调研报告");
      expect(extracted.value).toContain("红松、糖豆");
      expect(extracted.value).toContain("核心结论");
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("rejects incomplete DOCX reports with dangling markdown tables", async () => {
    const outDir = makeTempDir("lynn-docx-tool-");
    try {
      const tool = createDocxTool({ getDeskDir: () => outDir });
      const result = await tool.execute("test-call", {
        title: "中老年互联网内容生态调研报告",
        content: [
          "# 中老年互联网内容生态调研报告",
          "",
          "## 红松与糖豆",
          "这里有一些初步内容。",
          "",
          "| 对比维度 | 红松学堂 | 糖豆 |",
          "|",
        ].join("\n"),
      });

      expect(result.isError).toBe(true);
      expect(result.details.reason).toBe("DOCX_REPORT_INCOMPLETE");
      expect(fs.readdirSync(outDir)).toHaveLength(0);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("creates PPTX content and two-column slides without leaking theme scope errors", async () => {
    const outDir = makeTempDir("lynn-pptx-tool-");
    try {
      const tool = createPptxTool({ getDeskDir: () => outDir });
      const result = await tool.execute("test-call", {
        title: "工具群 PPT 冒烟",
        theme: "tech",
        slides: [
          { layout: "content", title: "目标", body: "- 修复长任务\n- 稳定生成" },
          { layout: "two_column", title: "左右对比", body: "- 左侧要点\n---\n- 右侧要点" },
        ],
      });

      const filePath = result.details.files[0].filePath;
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.statSync(filePath).size).toBeGreaterThan(1000);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("escapes poster content before writing standalone HTML", async () => {
    const outDir = makeTempDir("lynn-poster-tool-");
    try {
      const tool = createPosterTool({ getDeskDir: () => outDir });
      const result = await tool.execute("test-call", {
        title: "<img src=x onerror=alert(1)>",
        subtitle: "副标题 <b>unsafe</b>",
        content: "# 标题\n- <script>alert(1)</script>\n普通 <img src=x onerror=alert(1)>",
        footer: "footer <svg onload=alert(1)>",
      });

      const html = fs.readFileSync(result.details.files[0].filePath, "utf-8");
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<svg");
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain("&lt;img");
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("keeps stock research routed through configured Brain API roots", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "lib/tools/stock-research-tool.js"), "utf-8");
    expect(source).not.toContain("https://82.156.182.240");
    expect(source).toContain("BRAIN_API_ROOTS");
    expect(source).toContain("readSignedClientAgentHeaders");
  });

  it("rejects malformed or non-A-share stock research codes before calling Brain", async () => {
    expect(normalizeStockResearchTsCode("688629").tsCode).toBe("688629.SH");
    expect(normalizeStockResearchTsCode("002639").tsCode).toBe("002639.SZ");
    expect(normalizeStockResearchTsCode("206006").ok).toBe(false);
    expect(normalizeStockResearchTsCode("0700.HK").ok).toBe(false);
    expect(normalizeStockResearchTsCode("AAPL").ok).toBe(false);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await createStockResearchTool().execute("test-call", {
      code: "206006",
      name: "和腾讯控股",
    });

    expect(result.details.rejected).toBe(true);
    expect(result.content[0].text).toContain("不是有效 A 股代码");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not generate an empty report artifact", async () => {
    const outDir = makeTempDir("lynn-report-tool-");
    try {
      const tool = createReportTool({ getDeskDir: () => outDir });
      const result = await tool.execute("test-call", {
        title: "空报告不应生成",
        sections: [
          { title: "空章节", type: "text", content: "" },
        ],
      });

      expect(result.details.rejected).toBe(true);
      expect(result.content[0].text).toContain("报告内容不足");
      expect(fs.readdirSync(outDir)).toHaveLength(0);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("rejects shallow deep reports instead of generating a shell artifact", async () => {
    const outDir = makeTempDir("lynn-report-tool-");
    try {
      const tool = createReportTool({ getDeskDir: () => outDir });
      const result = await tool.execute("test-call", {
        title: "和腾讯控股(206006) 深度分析报告",
        sections: [
          { title: "结论", type: "text", content: "数据获取完成，但 AI 分析超时，使用数据直接生成。" },
        ],
      });

      expect(result.details.rejected).toBe(true);
      expect(result.details.reason).toBe("insufficient_deep_report_content");
      expect(result.content[0].text).toContain("未生成空壳报告");
      expect(fs.readdirSync(outDir)).toHaveLength(0);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("still allows concise non-deep one-section reports", async () => {
    const outDir = makeTempDir("lynn-report-tool-");
    try {
      const tool = createReportTool({ getDeskDir: () => outDir });
      const result = await tool.execute("test-call", {
        title: "会议纪要",
        sections: [
          { title: "摘要", type: "text", content: "本次会议确认了下周交付节奏、负责人和风险项。" },
        ],
      });

      expect(result.details.rejected).toBeUndefined();
      expect(fs.existsSync(result.details.files[0].filePath)).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
