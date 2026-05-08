import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildDeleteExtensionCommand,
  buildMoveExtensionCommand,
  extractExplicitDeleteTargetFromPrompt,
  extractPromptDeleteExtensionRequest,
  extractPromptMoveExtensionRequest,
  extractPseudoBashCommand,
  extractPseudoRemovePath,
  extractTargetFolderName,
  isInsidePath,
  isMeaningfulRecoveredBashCommand,
  looksLikeIncompleteLocalMutationProbe,
  looksLikeLocalMutationProbeCommand,
  normalizeMoveExtensionToken,
  resolveKnownFolderFromText,
  sanitizeFolderName,
  shellQuote,
} from "../server/chat/command-recovery.js";

describe("command recovery", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("builds executable move commands for extension folders", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-command-recovery-"));
    const sourceFolder = path.join(tempDir, "source");
    const targetFolder = path.join(tempDir, "target");
    fs.mkdirSync(sourceFolder, { recursive: true });
    fs.mkdirSync(targetFolder, { recursive: true });
    fs.writeFileSync(path.join(sourceFolder, "a.html"), "<p>a</p>");
    fs.writeFileSync(path.join(sourceFolder, "b.htm"), "<p>b</p>");
    fs.writeFileSync(path.join(sourceFolder, "keep.txt"), "keep");

    const command = buildMoveExtensionCommand({
      sourceFolder,
      targetFolder,
      extensions: ["html", "htm"],
    });

    expect(command).toContain("\\( -iname '*.html' -o -iname '*.htm' \\)");
    const output = execFileSync("bash", ["-lc", command], { encoding: "utf8" });

    expect(output).toContain("=== 移动命令已执行 ===");
    expect(fs.existsSync(path.join(targetFolder, "a.html"))).toBe(true);
    expect(fs.existsSync(path.join(targetFolder, "b.htm"))).toBe(true);
    expect(fs.existsSync(path.join(sourceFolder, "keep.txt"))).toBe(true);
    expect(fs.existsSync(path.join(sourceFolder, "a.html"))).toBe(false);
    expect(fs.existsSync(path.join(sourceFolder, "b.htm"))).toBe(false);
  });

  it("uses the file type as folder name for generic new-folder requests", () => {
    const request = extractPromptMoveExtensionRequest("把我桌面的图片整理到一个新的文件夹里");

    expect(request).toEqual({
      sourceFolder: path.join(os.homedir(), "Desktop"),
      targetFolder: path.join(os.homedir(), "Desktop", "图片"),
      extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "tiff", "svg"],
    });
  });

  // ── shellQuote ──

  it("shellQuote wraps value in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("0")).toBe("'0'");
  });

  it("shellQuote escapes embedded single quotes", () => {
    expect(shellQuote("it's working")).toBe("'it'\\''s working'");
    expect(shellQuote("'")).toBe("''\\'''");
  });

  // ── isMeaningfulRecoveredBashCommand ──

  it("isMeaningfulRecoveredBashCommand accepts real commands", () => {
    expect(isMeaningfulRecoveredBashCommand("ls -la")).toBe(true);
    expect(isMeaningfulRecoveredBashCommand("rm -f /tmp/test.txt")).toBe(true);
    expect(isMeaningfulRecoveredBashCommand("find . -name '*.js'")).toBe(true);
  });

  it("isMeaningfulRecoveredBashCommand rejects empty or whitespace", () => {
    expect(isMeaningfulRecoveredBashCommand("")).toBe(false);
    expect(isMeaningfulRecoveredBashCommand("   ")).toBe(false);
    expect(isMeaningfulRecoveredBashCommand("<>/\\")).toBe(false);
  });

  it("isMeaningfulRecoveredBashCommand rejects XML/markdown", () => {
    expect(isMeaningfulRecoveredBashCommand("<bash>")).toBe(false);
    expect(isMeaningfulRecoveredBashCommand("</find>")).toBe(false);
    expect(isMeaningfulRecoveredBashCommand("```bash")).toBe(false);
    expect(isMeaningfulRecoveredBashCommand("```sh")).toBe(false);
  });

  it("isMeaningfulRecoveredBashCommand rejects over-long strings", () => {
    expect(isMeaningfulRecoveredBashCommand("x".repeat(2001))).toBe(false);
  });

  // ── isInsidePath ──

  it("isInsidePath detects child inside parent", () => {
    expect(isInsidePath("/home/user/docs/report.txt", "/home/user")).toBe(true);
    expect(isInsidePath("/home/user", "/home/user")).toBe(true);
  });

  it("isInsidePath rejects paths outside parent", () => {
    expect(isInsidePath("/etc/passwd", "/home/user")).toBe(false);
    expect(isInsidePath("/home/user/../../../etc/passwd", "/home/user")).toBe(false);
  });

  // ── extractPseudoBashCommand ──

  it("extractPseudoBashCommand extracts from tool_code_begin/end", () => {
    const text = "<|tool_code_begin|>bash\nrm -f /tmp/test.txt\n<|tool_code_end|>";
    expect(extractPseudoBashCommand(text)).toBe("rm -f /tmp/test.txt");
  });

  it("extractPseudoBashCommand extracts from tool_call bash tags", () => {
    const text = "<tool_call>\n<bash command='ls'>\nls -la /tmp\n</bash>\n</tool_call>";
    expect(extractPseudoBashCommand(text)).toBe("ls -la /tmp");
  });

  it("extractPseudoBashCommand extracts from bare bash XML", () => {
    const text = "<bash>find . -name '*.js'</bash>";
    expect(extractPseudoBashCommand(text)).toBe("find . -name '*.js'");
  });

  it("extractPseudoBashCommand returns empty for no match", () => {
    expect(extractPseudoBashCommand("just some text")).toBe("");
    expect(extractPseudoBashCommand("")).toBe("");
  });

  // ── extractPseudoRemovePath ──

  it("extractPseudoRemovePath extracts from parens syntax", () => {
    const text = "<remove>(/tmp/junk.txt)</remove>";
    expect(extractPseudoRemovePath(text)).toBe("/tmp/junk.txt");
  });

  it("extractPseudoRemovePath extracts from path-tag syntax", () => {
    const text = "<remove_file>\n<path>/home/user/old.log</path>\n</remove_file>";
    expect(extractPseudoRemovePath(text)).toBe("/home/user/old.log");
  });

  it("extractPseudoRemovePath handles delete_file variant", () => {
    const text = "<delete_file>/tmp/stale.txt</delete_file>";
    expect(extractPseudoRemovePath(text)).toBe("/tmp/stale.txt");
  });

  it("extractPseudoRemovePath returns empty for no match", () => {
    expect(extractPseudoRemovePath("nothing here")).toBe("");
  });

  // ── extractExplicitDeleteTargetFromPrompt ──

  it("extractExplicitDeleteTargetFromPrompt detects Chinese delete patterns", () => {
    expect(extractExplicitDeleteTargetFromPrompt("删除 data.csv")).toBe("data.csv");
    expect(extractExplicitDeleteTargetFromPrompt("请删掉 report.pdf 文件")).toBe("report.pdf");
    expect(extractExplicitDeleteTargetFromPrompt("移除当前目录下 old backup.zip")).toBe("old backup.zip");
  });

  it("extractExplicitDeleteTargetFromPrompt detects English delete patterns", () => {
    expect(extractExplicitDeleteTargetFromPrompt("delete temp.log")).toBe("temp.log");
    expect(extractExplicitDeleteTargetFromPrompt("remove output.xlsx")).toBe("output.xlsx");
  });

  it("extractExplicitDeleteTargetFromPrompt rejects paths and dangerous chars", () => {
    expect(extractExplicitDeleteTargetFromPrompt("删除 /etc/passwd")).toBe("");
    expect(extractExplicitDeleteTargetFromPrompt("delete ../secret.txt")).toBe("");
    expect(extractExplicitDeleteTargetFromPrompt("删除 file*.txt")).toBe("");
  });

  it("extractExplicitDeleteTargetFromPrompt returns empty for non-delete prompts", () => {
    expect(extractExplicitDeleteTargetFromPrompt("你好")).toBe("");
    expect(extractExplicitDeleteTargetFromPrompt("read the file")).toBe("");
  });

  // ── extractPromptDeleteExtensionRequest ──

  it("extractPromptDeleteExtensionRequest detects extension delete in Downloads", () => {
    const result = extractPromptDeleteExtensionRequest("删除下载文件夹中所有zip文件");
    expect(result).toEqual({
      folder: path.join(os.homedir(), "Downloads"),
      extension: "zip",
    });
  });

  it("extractPromptDeleteExtensionRequest detects English pattern", () => {
    const result = extractPromptDeleteExtensionRequest("delete all pdf files from Downloads folder");
    expect(result).toEqual({
      folder: path.join(os.homedir(), "Downloads"),
      extension: "pdf",
    });
  });

  it("extractPromptDeleteExtensionRequest returns null without Downloads context", () => {
    expect(extractPromptDeleteExtensionRequest("删除所有的txt文件")).toBe(null);
    expect(extractPromptDeleteExtensionRequest("clean up")).toBe(null);
  });

  it("extractPromptDeleteExtensionRequest returns null for non-delete prompts", () => {
    expect(extractPromptDeleteExtensionRequest("把下载文件夹整理一下")).toBe(null);
  });

  // ── buildDeleteExtensionCommand ──

  it("buildDeleteExtensionCommand builds valid shell script", () => {
    const cmd = buildDeleteExtensionCommand({
      folder: "/tmp/test-dl",
      extension: "zip",
    });
    expect(cmd).toContain("dir='/tmp/test-dl'");
    expect(cmd).toContain("-iname '*.zip'");
    expect(cmd).toContain("=== 删除完成 ===");
    expect(cmd).toContain("rm -f");
  });

  it("buildDeleteExtensionCommand returns empty for invalid input", () => {
    expect(buildDeleteExtensionCommand(null)).toBe("");
    expect(buildDeleteExtensionCommand({})).toBe("");
    expect(buildDeleteExtensionCommand({ folder: "/tmp" })).toBe("");
  });

  // ── normalizeMoveExtensionToken ──

  it("normalizeMoveExtensionToken maps HTML variants", () => {
    expect(normalizeMoveExtensionToken("html")).toEqual(["html", "htm"]);
    expect(normalizeMoveExtensionToken("htm")).toEqual(["html", "htm"]);
    expect(normalizeMoveExtensionToken("网页")).toEqual(["html", "htm"]);
  });

  it("normalizeMoveExtensionToken maps Excel variants", () => {
    expect(normalizeMoveExtensionToken("xlsx")).toEqual(["xlsx", "xls", "xlsm", "csv"]);
    expect(normalizeMoveExtensionToken("excel")).toEqual(["xlsx", "xls", "xlsm", "csv"]);
    expect(normalizeMoveExtensionToken("表格")).toEqual(["xlsx", "xls", "xlsm", "csv"]);
  });

  it("normalizeMoveExtensionToken maps PDF", () => {
    expect(normalizeMoveExtensionToken("pdf")).toEqual(["pdf"]);
    expect(normalizeMoveExtensionToken("PDF")).toEqual(["pdf"]);
  });

  it("normalizeMoveExtensionToken maps image categories", () => {
    const images = normalizeMoveExtensionToken("图片");
    expect(images).toContain("png");
    expect(images).toContain("jpg");
    expect(images).toContain("webp");
    expect(images.length).toBe(10);
  });

  it("normalizeMoveExtensionToken passes through raw extensions", () => {
    // "csv" appears in the Excel regex group, so it maps to the full Excel family
    expect(normalizeMoveExtensionToken("csv")).toEqual(["xlsx", "xls", "xlsm", "csv"]);
    expect(normalizeMoveExtensionToken("txt")).toEqual(["txt"]);
  });

  it("normalizeMoveExtensionToken returns empty for unknown tokens", () => {
    expect(normalizeMoveExtensionToken("")).toEqual([]);
    expect(normalizeMoveExtensionToken("not-a-real-type")).toEqual([]);
  });

  // ── resolveKnownFolderFromText ──

  it("resolveKnownFolderFromText detects Downloads", () => {
    const result = resolveKnownFolderFromText("下载文件夹里的文件");
    expect(result).toBe(path.join(os.homedir(), "Downloads"));
  });

  it("resolveKnownFolderFromText detects Desktop", () => {
    expect(resolveKnownFolderFromText("桌面上的图片")).toBe(path.join(os.homedir(), "Desktop"));
    expect(resolveKnownFolderFromText("Desktop files")).toBe(path.join(os.homedir(), "Desktop"));
  });

  it("resolveKnownFolderFromText detects Documents", () => {
    expect(resolveKnownFolderFromText("文稿文件夹")).toBe(path.join(os.homedir(), "Documents"));
    expect(resolveKnownFolderFromText("my Documents")).toBe(path.join(os.homedir(), "Documents"));
  });

  it("resolveKnownFolderFromText returns fallback when no match", () => {
    expect(resolveKnownFolderFromText("随便什么文本", "/fallback")).toBe("/fallback");
    expect(resolveKnownFolderFromText("")).toBe("");
  });

  // ── sanitizeFolderName ──

  it("sanitizeFolderName removes quotes and suffixes", () => {
    expect(sanitizeFolderName('"图片"')).toBe("图片");
    expect(sanitizeFolderName("我的文件夹")).toBe("我");
    expect(sanitizeFolderName("图片目录")).toBe("图片");
  });

  it("sanitizeFolderName removes move-verb prefixes", () => {
    expect(sanitizeFolderName("移动到图片")).toBe("图片");
    expect(sanitizeFolderName("放进文档")).toBe("文档");
    expect(sanitizeFolderName("复制到备份")).toBe("备份");
  });

  it("sanitizeFolderName strips special chars and truncates", () => {
    expect(sanitizeFolderName("a/b:c*d?e")).toBe("abcde");
    expect(sanitizeFolderName("x".repeat(100)).length).toBeLessThanOrEqual(80);
  });

  it("sanitizeFolderName rejects generic placeholder names", () => {
    expect(sanitizeFolderName("一个新的")).toBe("");
    expect(sanitizeFolderName("新建的")).toBe("");
  });

  // ── extractTargetFolderName ──

  it("extractTargetFolderName extracts move target", () => {
    expect(extractTargetFolderName("把文件移动到图片文件夹")).toBe("图片");
    expect(extractTargetFolderName("放到文档目录里")).toBe("文档");
    expect(extractTargetFolderName("归档到备份")).toBe("备份");
  });

  it("extractTargetFolderName handles 全部/所有 patterns", () => {
    expect(extractTargetFolderName("把所有文件都放进图片")).toBe("图片");
    expect(extractTargetFolderName("全部放到归档")).toBe("归档");
  });

  it("extractTargetFolderName returns empty for no match", () => {
    expect(extractTargetFolderName("你好世界")).toBe("");
  });

  // ── looksLikeIncompleteLocalMutationProbe ──

  it("looksLikeIncompleteLocalMutationProbe detects find/ls without mutation verbs", () => {
    expect(looksLikeIncompleteLocalMutationProbe("bash", { command: "find . -name '*.js'" }, "file1.js\nfile2.js")).toBe(false);
    expect(looksLikeIncompleteLocalMutationProbe("find", { command: "find ." }, "usage: find ...")).toBe(true);
  });

  it("looksLikeIncompleteLocalMutationProbe detects bare find/ls/pwd", () => {
    expect(looksLikeIncompleteLocalMutationProbe("bash", { command: "ls" })).toBe(true);
    expect(looksLikeIncompleteLocalMutationProbe("bash", { command: "pwd" })).toBe(true);
  });

  it("looksLikeIncompleteLocalMutationProbe rejects commands with mutation verbs", () => {
    expect(looksLikeIncompleteLocalMutationProbe("bash", { command: "rm file.txt" })).toBe(false);
    expect(looksLikeIncompleteLocalMutationProbe("bash", { command: "mv a b" })).toBe(false);
  });

  it("looksLikeIncompleteLocalMutationProbe ignores non-bash/find/ls tools", () => {
    expect(looksLikeIncompleteLocalMutationProbe("read_file", {})).toBe(false);
    expect(looksLikeIncompleteLocalMutationProbe("web_search", { query: "test" })).toBe(false);
  });

  // ── looksLikeLocalMutationProbeCommand ──

  it("looksLikeLocalMutationProbeCommand detects probe commands", () => {
    expect(looksLikeLocalMutationProbeCommand({ name: "bash", command: "find . -maxdepth 1" })).toBe(true);
    expect(looksLikeLocalMutationProbeCommand({ name: "bash", command: "ls" })).toBe(true);
    expect(looksLikeLocalMutationProbeCommand({ name: "find", command: "find . -name test" })).toBe(true);
  });

  it("looksLikeLocalMutationProbeCommand rejects real mutation commands", () => {
    expect(looksLikeLocalMutationProbeCommand({ name: "bash", command: "rm -rf /tmp/test" })).toBe(false);
    expect(looksLikeLocalMutationProbeCommand({ name: "bash", command: "mv file.txt done/" })).toBe(false);
    expect(looksLikeLocalMutationProbeCommand({ name: "bash", command: "find . -delete" })).toBe(false);
  });

  it("looksLikeLocalMutationProbeCommand ignores non-bash/find/ls tools", () => {
    expect(looksLikeLocalMutationProbeCommand({ name: "read_file", command: "rm file" })).toBe(false);
  });
});
