#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = process.env.LYNN_GITHUB_REPO || "MerkyorLynn/Lynn";
const desktop = path.join(os.homedir(), "Desktop");
const outDir = process.env.LYNN_ISSUE_DIGEST_DIR || path.join(desktop, "Lynn-GitHub-Issue-Digests");
const now = new Date();
const today = now.toISOString().slice(0, 10);
const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

function runGh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        process.env.PATH || "",
      ].join(":"),
    },
  });
}

function formatLabels(labels = []) {
  if (!labels.length) return "无";
  return labels.map((label) => label.name || label).filter(Boolean).join(", ") || "无";
}

function formatAuthor(author) {
  return author?.login || "unknown";
}

function issueLine(issue) {
  return `- [#${issue.number}](${issue.url}) ${issue.title} · @${formatAuthor(issue.author)} · labels: ${formatLabels(issue.labels)} · comments: ${issue.comments}`;
}

function isAfter(value, boundary) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date >= boundary;
}

function buildDigest(issues) {
  const newIssues = issues.filter((issue) => isAfter(issue.createdAt, since));
  const updatedIssues = issues.filter((issue) => isAfter(issue.updatedAt, since));
  const unlabeledIssues = issues.filter((issue) => !Array.isArray(issue.labels) || issue.labels.length === 0);
  const recentlyUpdated = [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 20);

  const sections = [
    `# Lynn GitHub Issue 日报 · ${today}`,
    "",
    `Repo: [${repo}](https://github.com/${repo})`,
    `Generated: ${now.toLocaleString("zh-CN", { hour12: false })}`,
    "",
    "## 摘要",
    "",
    `- Open issues: ${issues.length}`,
    `- 过去 24h 新增: ${newIssues.length}`,
    `- 过去 24h 更新: ${updatedIssues.length}`,
    `- 未打 label: ${unlabeledIssues.length}`,
    "",
    "## 过去 24h 新增",
    "",
    newIssues.length ? newIssues.map(issueLine).join("\n") : "- 无",
    "",
    "## 过去 24h 更新",
    "",
    updatedIssues.length ? updatedIssues.map(issueLine).join("\n") : "- 无",
    "",
    "## 未打 label",
    "",
    unlabeledIssues.length ? unlabeledIssues.map(issueLine).join("\n") : "- 无",
    "",
    "## 最近更新 Top 20",
    "",
    recentlyUpdated.length ? recentlyUpdated.map(issueLine).join("\n") : "- 无",
    "",
    "## 操作建议",
    "",
    "- 新 issue 先确认复现信息是否完整；缺日志/版本/系统信息时优先追问。",
    "- Windows 启动/安装类问题优先看 crash.log 与本地数据迁移。",
    "- 未打 label 的 issue 每天清一次，避免 triage 积压。",
    "",
  ];

  return sections.join("\n");
}

function notify(title, message) {
  if (process.argv.includes("--no-notify")) return;
  spawnSync("osascript", [
    "-e",
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
  ], { stdio: "ignore" });
}

function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const raw = runGh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,title,author,labels,updatedAt,createdAt,url,comments",
  ]);
  const issues = JSON.parse(raw);
  const digest = buildDigest(issues);
  const outputPath = path.join(outDir, `issues-${today}.md`);
  const latestPath = path.join(outDir, "latest.md");
  fs.writeFileSync(outputPath, digest, "utf8");
  fs.writeFileSync(latestPath, digest, "utf8");
  console.log(`[issue-scan] wrote ${outputPath}`);
  notify("Lynn Issue 日报已生成", `${issues.length} 个 open issues，日报已写到桌面。`);
}

main();
