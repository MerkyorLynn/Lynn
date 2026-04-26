/**
 * report-tool.js — 专业 HTML 报告生成工具（create_report）
 *
 * Agent 提供结构化数据（标题、指标、章节），工具使用内置深色主题模板
 * 渲染精美 HTML 报告页面。不依赖模型生成 CSS。
 */
import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { t } from "../../server/i18n.js";

const REPORT_CSS = `:root{--bg:#080b14;--s1:#0e1421;--s2:#151e2e;--bd:#1c2640;--t:#e2e8f0;--td:#7b8ca5;--ac:#ef4444;--ac2:#f87171;--grn:#10b981;--amb:#f59e0b;--blu:#3b82f6;--pur:#a78bfa}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--t);font-family:"Noto Sans SC",system-ui,sans-serif;line-height:1.7}.c{max-width:1060px;margin:0 auto;padding:36px 20px}.hdr{text-align:center;padding:48px 0 28px;position:relative}.hdr::after{content:"";position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:140px;height:2px;background:linear-gradient(90deg,transparent,var(--ac),transparent)}.tag{font-size:12px;color:var(--ac);letter-spacing:4px;font-weight:700}.hdr h1{font-size:30px;font-weight:900;background:linear-gradient(135deg,#fff,var(--ac2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin:6px 0}.hdr .sub{color:var(--td);font-size:13px}.badge{display:inline-block;margin-top:12px;padding:3px 14px;border:1px solid var(--bd);border-radius:16px;font-size:11px;color:var(--td)}.sec{margin:38px 0}.sec-t{font-size:19px;font-weight:700;margin-bottom:16px;padding-left:12px;border-left:3px solid var(--ac);display:flex;align-items:center;gap:8px}.sec-t .n{font-size:11px;color:var(--ac);letter-spacing:2px}.ab{background:var(--s1);border:1px solid var(--bd);border-radius:11px;padding:20px;margin:14px 0}.ab h4{color:var(--ac);font-size:14px;margin-bottom:10px;font-weight:700}.ab p{font-size:13px;line-height:1.8;margin-bottom:7px}table.dt{width:100%;border-collapse:collapse;font-size:13px;margin:12px 0}.dt th{text-align:left;padding:7px 10px;background:var(--s2);color:var(--td);font-weight:500;font-size:11px;letter-spacing:1px;border-bottom:1px solid var(--bd)}.dt td{padding:7px 10px;border-bottom:1px solid var(--bd)}.cg{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:14px 0}.cd{background:var(--s1);border:1px solid var(--bd);border-radius:9px;padding:14px;text-align:center}.cd .lb{font-size:10px;color:var(--td);letter-spacing:1px;margin-bottom:3px}.cd .vl{font-size:22px;font-weight:900}.cd .ch{font-size:11px;margin-top:2px}.up{color:var(--grn)}.dn{color:var(--ac)}.nt-c{color:var(--amb)}.vd{background:linear-gradient(135deg,#150a0a,#1a0e15);border:1px solid var(--ac);border-radius:14px;padding:24px;margin:22px 0;position:relative;overflow:hidden}.vd::before{content:"";position:absolute;top:-40%;right:-12%;width:220px;height:220px;background:radial-gradient(circle,rgba(239,68,68,.06),transparent 70%);border-radius:50%}.vd h3{font-size:17px;font-weight:700;color:var(--ac2);margin-bottom:12px}.vd-g{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}@media(max-width:640px){.vd-g{grid-template-columns:1fr}}.vd-i{padding:12px;background:rgba(255,255,255,.02);border-radius:8px;border:1px solid rgba(239,68,68,.1)}.vd-i .pr{font-size:11px;color:var(--ac);font-weight:700;letter-spacing:2px;margin-bottom:4px}.vd-i .rg{font-size:19px;font-weight:900;margin-bottom:3px}.vd-i .nt{font-size:12px;color:var(--td);line-height:1.5}.warn{background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);border-radius:10px;padding:16px;margin:14px 0}.warn h4{color:var(--ac);font-size:13px;font-weight:800;margin-bottom:8px}.warn p{font-size:12px;color:var(--ac2);line-height:1.7;margin-bottom:5px}.disc{margin-top:44px;padding:16px;border-top:1px solid var(--bd);font-size:11px;color:var(--td);line-height:1.8;text-align:center}`;

function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function bold(s) { return String(s || "").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"); }
function dirCls(d) { return d === "up" ? "up" : d === "down" ? "dn" : "nt-c"; }
function nl2p(s) { return bold(esc(s)).split(/\n+/).filter(Boolean).map((p) => `<p>${p}</p>`).join(""); }

function renderReport({ title, tag, subtitle, date, sections, disclaimer }) {
  let body = "";
  body += `<div class="hdr">`;
  if (tag) body += `<div class="tag">${esc(tag)}</div>`;
  body += `<h1>${esc(title)}</h1>`;
  if (subtitle) body += `<div class="sub">${esc(subtitle)}</div>`;
  body += `<div class="badge">报告日期：${esc(date)}</div></div>`;

  sections.forEach((sec, i) => {
    const num = String(i + 1).padStart(2, "0");
    if (sec.type === "warning") {
      body += `<div class="warn"><h4>⚠ ${esc(sec.title)}</h4>${nl2p(sec.content || "")}</div>`;
      return;
    }
    body += `<div class="sec"><div class="sec-t"><span class="n">${num}</span> ${esc(sec.title)}</div>`;

    if (sec.type === "metrics" && Array.isArray(sec.metrics)) {
      body += `<div class="cg">`;
      for (const m of sec.metrics) {
        const d = dirCls(m.direction);
        body += `<div class="cd"><div class="lb">${esc(m.label)}</div><div class="vl ${d}">${esc(m.value)}</div>`;
        if (m.change) body += `<div class="ch ${d}">${esc(m.change)}</div>`;
        body += `</div>`;
      }
      body += `</div>`;
    }

    if (sec.type === "text") {
      if (Array.isArray(sec.blocks) && sec.blocks.length) {
        for (const b of sec.blocks) {
          body += `<div class="ab">`;
          if (b.heading) body += `<h4>▎${esc(b.heading)}</h4>`;
          body += nl2p(b.text || "");
          body += `</div>`;
        }
      } else if (sec.content) {
        body += `<div class="ab">${nl2p(sec.content)}</div>`;
      }
    }

    if (sec.type === "table" && Array.isArray(sec.headers)) {
      body += `<div class="ab"><table class="dt"><tr>`;
      for (const h of sec.headers) body += `<th>${esc(h)}</th>`;
      body += `</tr>`;
      for (const row of (sec.rows || [])) {
        body += `<tr>`;
        for (const cell of row) {
          const isUp = /涨|增|\+|扭亏/.test(cell);
          const isDn = /跌|降|亏|-/.test(cell);
          body += `<td class="${isUp ? "up" : isDn ? "dn" : ""}">${esc(cell)}</td>`;
        }
        body += `</tr>`;
      }
      body += `</table></div>`;
    }

    if (sec.type === "verdict" && Array.isArray(sec.items)) {
      body += `<div class="vd"><h3>走势预判</h3><div class="vd-g">`;
      for (const it of sec.items) {
        body += `<div class="vd-i"><div class="pr">${esc(it.period)}</div><div class="rg">${esc(it.range)}</div><div class="nt">${esc(it.note)}</div></div>`;
      }
      body += `</div></div>`;
    }

    body += `</div>`;
  });

  body += `<div class="disc">${esc(disclaimer)}</div>`;

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${esc(title)}</title><link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;700;900&display=swap" rel="stylesheet"><style>${REPORT_CSS}</style></head><body><div class="c">${body}</div></body></html>`;
}

function safeFilename(title) {
  return title.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "report";
}

function hasText(value, minLength = 12) {
  return String(value || "").replace(/\s+/g, "").length >= minLength;
}

function hasMeaningfulSection(section) {
  if (!section || typeof section !== "object") return false;
  if (section.type === "metrics") {
    return Array.isArray(section.metrics)
      && section.metrics.some((item) => hasText(item?.label, 1) && hasText(item?.value, 1));
  }
  if (section.type === "text") {
    if (hasText(section.content)) return true;
    return Array.isArray(section.blocks)
      && section.blocks.some((block) => hasText(block?.text));
  }
  if (section.type === "table") {
    return Array.isArray(section.headers)
      && section.headers.length > 0
      && Array.isArray(section.rows)
      && section.rows.some((row) => Array.isArray(row) && row.some((cell) => hasText(cell, 1)));
  }
  if (section.type === "verdict") {
    return Array.isArray(section.items)
      && section.items.some((item) => hasText(item?.period, 1) && hasText(item?.range, 1));
  }
  if (section.type === "warning") {
    return hasText(section.content);
  }
  return hasText(section.content);
}

let _counter = 0;

export function createReportTool({ getDeskDir } = {}) {
  return {
    name: "create_report",
    label: t("toolDef.report.label"),
    description: t("toolDef.report.description"),
    parameters: Type.Object({
      title: Type.String({ description: t("toolDef.report.titleDesc") }),
      tag: Type.Optional(Type.String({ description: t("toolDef.report.tagDesc") })),
      subtitle: Type.Optional(Type.String({ description: t("toolDef.report.subtitleDesc") })),
      date: Type.Optional(Type.String({ description: t("toolDef.report.dateDesc") })),
      sections: Type.Array(
        Type.Object({
          title: Type.String({ description: t("toolDef.report.secTitleDesc") }),
          type: StringEnum(["metrics", "text", "table", "verdict", "warning"], {
            description: t("toolDef.report.secTypeDesc"),
          }),
          metrics: Type.Optional(Type.Array(Type.Object({
            label: Type.String(),
            value: Type.String(),
            change: Type.Optional(Type.String()),
            direction: Type.Optional(StringEnum(["up", "down", "neutral"])),
          }))),
          content: Type.Optional(Type.String()),
          blocks: Type.Optional(Type.Array(Type.Object({
            heading: Type.Optional(Type.String()),
            text: Type.String(),
          }))),
          headers: Type.Optional(Type.Array(Type.String())),
          rows: Type.Optional(Type.Array(Type.Array(Type.String()))),
          items: Type.Optional(Type.Array(Type.Object({
            period: Type.String(),
            range: Type.String(),
            note: Type.Optional(Type.String()),
          }))),
        }),
        { minItems: 1, description: t("toolDef.report.sectionsDesc") },
      ),
      disclaimer: Type.Optional(Type.String({ description: t("toolDef.report.disclaimerDesc") })),
    }),
    execute: async (_toolCallId, params) => {
      const date = params.date || new Date().toLocaleDateString("zh-CN");
      const disclaimer = params.disclaimer || "本报告基于公开信息整理，不构成任何投资建议，请审慎决策。";
      const meaningfulSections = Array.isArray(params.sections)
        ? params.sections.filter(hasMeaningfulSection)
        : [];

      if (!meaningfulSections.length) {
        return {
          content: [{
            type: "text",
            text: "报告内容不足，未生成空报告。请先补充至少一个包含正文、指标、表格数据或走势判断的有效章节。",
          }],
          details: { rejected: true, reason: "empty_report_sections" },
        };
      }

      const html = renderReport({
        title: params.title,
        tag: params.tag || "",
        subtitle: params.subtitle || "",
        date,
        sections: meaningfulSections,
        disclaimer,
      });

      // Save to file
      const filename = `${safeFilename(params.title)}.html`;
      let outDir = getDeskDir?.();
      if (!outDir) outDir = (await import("os")).tmpdir();
      fs.mkdirSync(outDir, { recursive: true });
      const filePath = path.join(outDir, filename);
      fs.writeFileSync(filePath, html, "utf-8");

      // Also return as artifact for preview
      const artifactId = `report-${Date.now()}-${++_counter}`;

      return {
        content: [{ type: "text", text: t("toolDef.report.created", { title: params.title, path: filePath, count: params.sections.length }) }],
        details: {
          artifactId,
          type: "html",
          title: params.title,
          content: html,
          files: [{ filePath, label: filename, ext: "html" }],
        },
      };
    },
  };
}
