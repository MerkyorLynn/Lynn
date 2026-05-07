/**
 * docx-tool.js — Word 文档生成工具（create_docx）
 *
 * 生成最小但标准的 Office Open XML .docx 文件。这里刻意不引入 zip/docx
 * 新依赖，避免增加桌面端打包体积和跨平台 native 风险。
 */
import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeFilename(title, ext = "docx") {
  const base = String(title || "report")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "report";
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

function stripInlineMarkdown(text) {
  return String(text || "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

function paragraphXml(text, styleId = "Normal") {
  const value = stripInlineMarkdown(text);
  const style = styleId && styleId !== "Normal"
    ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>`
    : "";
  return `<w:p>${style}<w:r><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:p>`;
}

function contentToParagraphs({ title, content }) {
  const paragraphs = [paragraphXml(title, "Title")];
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      paragraphs.push("<w:p/>");
      continue;
    }
    if (/^#{1,3}\s+/.test(line)) {
      const level = Math.min(3, (line.match(/^#+/)?.[0] || "#").length);
      paragraphs.push(paragraphXml(line.replace(/^#{1,3}\s+/, ""), `Heading${level}`));
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)/);
    if (bullet) {
      paragraphs.push(paragraphXml(`• ${bullet[1]}`, "Normal"));
      continue;
    }
    const numbered = line.match(/^\d+[.)、]\s+(.+)/);
    if (numbered) {
      paragraphs.push(paragraphXml(line, "Normal"));
      continue;
    }
    if (/^[-*_]{3,}$/.test(line)) {
      paragraphs.push("<w:p/>");
      continue;
    }
    paragraphs.push(paragraphXml(line, "Normal"));
  }

  return paragraphs.join("");
}

function documentXml(params) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 wp14">
  <w:body>
    ${contentToParagraphs(params)}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
      <w:cols w:space="708"/>
      <w:docGrid w:linePitch="312"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
    <w:rPr><w:rFonts w:ascii="Aptos" w:eastAsia="Microsoft YaHei" w:hAnsi="Aptos"/><w:sz w:val="22"/></w:rPr>
    <w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:rPr><w:b/><w:rFonts w:ascii="Aptos Display" w:eastAsia="Microsoft YaHei" w:hAnsi="Aptos Display"/><w:sz w:val="36"/></w:rPr>
    <w:pPr><w:spacing w:after="260"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:rPr><w:b/><w:color w:val="1F4E79"/><w:sz w:val="30"/></w:rPr>
    <w:pPr><w:spacing w:before="280" w:after="160"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:rPr><w:b/><w:color w:val="2F5496"/><w:sz w:val="26"/></w:rPr>
    <w:pPr><w:spacing w:before="220" w:after="120"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:rPr><w:b/><w:color w:val="5B6E8C"/><w:sz w:val="24"/></w:rPr>
    <w:pPr><w:spacing w:before="180" w:after="100"/></w:pPr>
  </w:style>
</w:styles>`;
}

function contentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="${DOCX_MIME}.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function relsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function corePropsXml({ title, author }) {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(title)}</dc:title>
  <dc:creator>${escapeXml(author || "Lynn")}</dc:creator>
  <cp:lastModifiedBy>${escapeXml(author || "Lynn")}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function appPropsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Lynn</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
</Properties>`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value & 0xffff, 0);
  return b;
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, day } = dosDateTime();

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
    const crc = crc32(data);
    const size = data.length;

    const localHeader = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(time), u16(day),
      u32(crc), u32(size), u32(size), u16(name.length), u16(0), name,
    ]);
    localParts.push(localHeader, data);

    const centralHeader = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(time), u16(day),
      u32(crc), u32(size), u32(size), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name,
    ]);
    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralSize), u32(offset), u16(0),
  ]);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export function createDocxBuffer({ title, content, author } = {}) {
  const docTitle = String(title || "Lynn 文档").trim() || "Lynn 文档";
  return createZip([
    { name: "[Content_Types].xml", data: contentTypesXml() },
    { name: "_rels/.rels", data: relsXml() },
    { name: "word/document.xml", data: documentXml({ title: docTitle, content }) },
    { name: "word/styles.xml", data: stylesXml() },
    { name: "docProps/core.xml", data: corePropsXml({ title: docTitle, author }) },
    { name: "docProps/app.xml", data: appPropsXml() },
  ]);
}

function looksLikeReportTitle(text = "") {
  return /(?:报告|调研|研究|分析|白皮书|方案|proposal|report|research|analysis)/i.test(String(text || ""));
}

function hasDanglingMarkdownTable(content = "") {
  const lines = String(content || "").trimEnd().split(/\r?\n/);
  const tail = lines.slice(-5).map((line) => line.trim()).filter(Boolean);
  return tail.some((line) => line === "|" || /^\|(?:\s*[-:]+?\s*\|?){1,}$/.test(line));
}

function assertDocxContentQuality({ title, content } = {}) {
  const normalizedContent = String(content || "").trim();
  const compactLen = normalizedContent.replace(/\s+/g, "").length;
  if (compactLen < 20) {
    const err = new Error("DOCX 内容不足，未生成文件");
    err.code = "DOCX_CONTENT_TOO_SHORT";
    throw err;
  }

  const reportLike = looksLikeReportTitle(title) || looksLikeReportTitle(normalizedContent.slice(0, 240));
  const progressOrFailure = /(?:正在|继续(?:整理|调研|深挖|生成)?|稍后|还需要|未完成|未能完成|失败|空转|工具调用|tool|fetch failed|timeout|AI 分析超时|使用数据直接生成)/i.test(normalizedContent);
  if (reportLike && (compactLen < 800 || progressOrFailure || hasDanglingMarkdownTable(normalizedContent))) {
    const err = new Error("DOCX 报告正文疑似未完成或被截断，未生成文件");
    err.code = "DOCX_REPORT_INCOMPLETE";
    throw err;
  }
}

export function writeDocxFile({ outDir, title, content, author, filename } = {}) {
  const normalizedTitle = String(title || "Lynn 文档").trim() || "Lynn 文档";
  const normalizedContent = String(content || "").trim();
  assertDocxContentQuality({ title: normalizedTitle, content: normalizedContent });
  const targetDir = outDir || process.cwd();
  fs.mkdirSync(targetDir, { recursive: true });
  const name = safeFilename(filename || normalizedTitle);
  const filePath = path.join(targetDir, name);
  fs.writeFileSync(filePath, createDocxBuffer({
    title: normalizedTitle,
    content: normalizedContent,
    author,
  }));
  return {
    filePath,
    label: path.basename(filePath),
    ext: "docx",
  };
}

export function createDocxTool({ getDeskDir } = {}) {
  return {
    name: "create_docx",
    label: "生成 Word 文档",
    description: "把完整正文生成 .docx Word 文档附件。适合调研报告、会议纪要、方案文档、可交付正文；不要只生成占位或空壳文件。",
    parameters: Type.Object({
      title: Type.String({ description: "文档标题" }),
      content: Type.String({ minLength: 20, description: "要写入 Word 文档的完整正文，支持基础 Markdown 标题和列表" }),
      filename: Type.Optional(Type.String({ description: "可选文件名，默认使用标题" })),
      author: Type.Optional(Type.String({ description: "可选作者名" })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const file = writeDocxFile({
          outDir: getDeskDir?.() || process.cwd(),
          title: params.title,
          content: params.content,
          filename: params.filename,
          author: params.author || "Lynn",
        });
        return {
          content: [{ type: "text", text: `已生成 Word 文档：${file.filePath}` }],
          details: { files: [file] },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err?.message || "DOCX 生成失败" }],
          details: { rejected: true, reason: err?.code || "docx_generation_failed" },
        };
      }
    },
  };
}
