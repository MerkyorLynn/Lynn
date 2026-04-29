import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

import {
  sanitizeHtml,
  sanitizeHtmlArtifact,
} from "../desktop/src/react/utils/sanitize.ts";

let dom;
let previousWindow;
let previousDocument;

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

describe("sanitizeHtmlArtifact", () => {
  it("keeps full-document report structure while stripping executable payloads", () => {
    const html = `<!doctype html>
      <html lang="zh-CN">
        <head>
          <meta charset="UTF-8">
          <title>华丰科技深度报告</title>
          <style>
            body { background: #080b14; color: #fff; }
            .hero { padding: 24px; }
          </style>
          <script>alert("xss")</script>
        </head>
        <body onload="alert(1)">
          <main class="hero">
            <h1 onclick="alert(2)">报告标题</h1>
            <a href="javascript:alert(3)">危险链接</a>
            <img src="x" onerror="alert(4)" alt="x">
          </main>
        </body>
      </html>`;

    const cleaned = sanitizeHtmlArtifact(html);

    expect(cleaned).toMatch(/<html/i);
    expect(cleaned).toMatch(/<head/i);
    expect(cleaned).toContain("<style>");
    expect(cleaned).toContain("background: #080b14");
    expect(cleaned).toMatch(/<body/i);
    expect(cleaned).toContain("报告标题");
    expect(cleaned).not.toMatch(/<script/i);
    expect(cleaned).not.toContain("onload=");
    expect(cleaned).not.toContain("onclick=");
    expect(cleaned).not.toContain("onerror=");
    expect(cleaned).not.toContain("javascript:");
  });

  it("does not expand ordinary markdown sanitization to whole documents", () => {
    const cleaned = sanitizeHtml("<html><head><style>body{color:red}</style></head><body><p>正文</p></body></html>");

    expect(cleaned).toContain("<p>正文</p>");
    expect(cleaned).not.toContain("<style>");
    expect(cleaned).not.toMatch(/<head|<body|<html/i);
  });
});
