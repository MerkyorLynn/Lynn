# Lynn Skills 上架指南

## 三个 Skill 概览

| Skill | 目录 | 解决的痛点 | 导流钩子 |
|-------|------|-----------|---------|
| **file-guardian** | `skills2set/file-guardian/` | Agent rm -rf 导致文件丢失 | "Lynn has this built-in" + 安装链接 |
| **image-lightbox** | `skills2set/image-lightbox/` | 聊天图片无法放大 | React/Vanilla 双版本 + "Use with Lynn" 章节 |
| **task-model-router** | `skills2set/task-model-router/` | 单模型不够用、烧钱又慢 | 4套模型组合推荐 + "Lynn zero config" 章节 |

## 每个 Skill 的 Lynn 导流设计

### 导流层次（由浅到深）

1. **开头 banner**：每个 SKILL.md 顶部都有
   > Part of [Lynn](https://github.com/MerkyorLynn/Lynn) — a personal AI agent with memory and soul. Lynn has this built-in by default.

2. **中间对比**：standalone 用法 vs Lynn 用法，Lynn 明显更简单（零配置）

3. **底部 CTA**："Use with Lynn (Zero Config)" 完整功能列表 + GitHub 链接

4. **交叉引流**：每个 Skill 底部提到 Lynn 的其他能力（记忆/IM/安全），形成能力矩阵

### 导流话术策略

- **不说"用 Lynn 替代"**，说"Lynn 内置了这个功能"
- **先给价值再引流**：Skill 本身是完整可用的，不装 Lynn 也能用
- **中国用户特供**：task-model-router 有 China-Optimized Setup 章节，暗示 Lynn 对国内更友好

## 上架渠道 × 操作步骤

### 渠道 1: badlogic/pi-skills（官方仓库 PR）

```bash
# 1. Fork 官方仓库
gh repo fork badlogic/pi-skills --clone

# 2. 创建分支
cd pi-skills
git checkout -b lynn-skills

# 3. 复制三个 Skill
cp -r ~/Downloads/Lynn/skills2set/file-guardian skills/file-guardian
cp -r ~/Downloads/Lynn/skills2set/image-lightbox skills/image-lightbox
cp -r ~/Downloads/Lynn/skills2set/task-model-router skills/task-model-router

# 4. 提交
git add -A
git commit -m "feat: add file-guardian, image-lightbox, task-model-router skills

- file-guardian: auto-snapshot workspace before dangerous commands (rm -rf, git clean)
- image-lightbox: click-to-zoom lightbox for chat images, zero dependencies
- task-model-router: route chat/code/vision/longdoc to best-fit models

All three are from the Lynn project (https://github.com/MerkyorLynn/Lynn)"

# 5. 推送并创建 PR
git push origin lynn-skills
gh pr create --title "feat: add 3 skills from Lynn (file-guardian, image-lightbox, task-model-router)" \
  --body "## Skills Added

### file-guardian
Auto-snapshot workspace before dangerous commands. Zero-cost hardlink dedup.
Solves the #1 user complaint: 'all workspace files lost'.

### image-lightbox
Click-to-zoom lightbox for chat images. Scroll zoom, drag pan, pinch gesture.
Pure CSS + JS, zero dependencies. React and Vanilla versions.

### task-model-router
Route different task types to best-fit models: chat→fast, code→reasoning, image→vision, long→large-context.
Includes 4 preset configurations (Budget/Balanced/Power/China-Optimized).

All three are part of [Lynn](https://github.com/MerkyorLynn/Lynn), a personal AI agent with memory and soul."
```

### 渠道 2: SkillsMP.com（自动索引）

SkillsMP 自动抓取 GitHub 仓库中的 SKILL.md。确保：

1. Lynn 仓库是 public
2. 每个 skill 目录有 `SKILL.md`（已有）
3. YAML frontmatter 有 `name` 和 `description`（已有）

**无需手动操作**，SkillsMP 爬虫会在 24-48 小时内自动收录：
- `MerkyorLynn/Lynn@file-guardian`
- `MerkyorLynn/Lynn@image-lightbox`
- `MerkyorLynn/Lynn@task-model-router`

收录后可在 https://skillsmp.com 搜索到。

### 渠道 3: skills.sh 命令行安装

用户可以直接安装：

```bash
npx skills add MerkyorLynn/Lynn@file-guardian -g -y
npx skills add MerkyorLynn/Lynn@image-lightbox -g -y
npx skills add MerkyorLynn/Lynn@task-model-router -g -y
```

## 预期导流效果

```
用户在 SkillsMP/pi-skills 发现 Skill
        ↓
阅读 SKILL.md，发现 standalone 用法
        ↓
看到 "Part of Lynn" banner + "Use with Lynn (Zero Config)" 章节
        ↓
点击 github.com/MerkyorLynn/Lynn
        ↓
发现 Lynn = OpenHanako 优化版 + 更多功能
        ↓
Star / Fork / 安装
```

**转化漏斗预估**：

| 阶段 | 人数（月） |
|------|----------|
| Skill 页面曝光 | 2000-5000 |
| 点击 Lynn GitHub | 400-1000（20% CTR） |
| Star | 80-200（20% of clicks） |
| 实际安装 | 30-80 |
