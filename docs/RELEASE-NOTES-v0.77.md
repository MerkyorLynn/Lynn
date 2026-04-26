# Lynn v0.77 · Release Notes

> 发布日期: 2026-05-XX  ·  代号: **「记得住,听得见」**

## 一句话

Lynn 学会了**永久记忆**和**听语音**——同样的硬件,**从工具进化为伙伴**。

---

## 🎉 三大新能力

### 1. 永久语义记忆 (RAG)
- **Lynn 现在记得你说过的所有事**,即使一年后用不同的词问也能找回
- 6 层记忆系统升级为 **关键词检索 + 向量召回 + 重排** 三段式
- 跨会话上下文自动注入,告别"上次那个事 Lynn 不记得"

**典型对话**:
```
用户: 上次我们调 vllm 的那个事咋样了?
Lynn: 你 4 月 12 日把 vllm 从 128K 降到 64K,
      gpu-memory-utilization 设 0.85,加了 qwen3_coder parser。
      3 天前你提过想测 v0.76.3 的 read 工具优化,要继续这个吗?
```

### 2. 个人本地知识库
- **拖文件入 Lynn 窗口**,自动 chunking + 向量化 + 入库
- 支持 PDF / Markdown / DOCX / TXT / 代码文件
- 完全本地存储,**0 数据上传**
- 100 个文档 5 分钟索引完毕

**典型对话**:
```
用户:(拖入 ~/notes 整个文件夹 50 个 md)
Lynn: 已索引 50 个文档,共 2,341 个 chunks。可以问我任何相关问题
用户: 我之前写过一篇 MoE 量化对比的笔记,在哪里来着?
Lynn: 找到 3 篇相关:
       📄 2026-03-12 《MoE FP8 vs 4bit 实测》
       📄 2026-03-15 《Qwen 系列量化对照》
       📄 2026-04-01 《vllm parser 选型》
```

### 3. 语音输入 + 转写
- **按住麦克风按钮说话**,5 秒录音 1 秒转文字
- 支持中英日韩等 99 种语言,自动检测
- 拖入音频/视频文件 → 自动转写 → 可继续对话
- 30 分钟会议录音 → 1 分钟出文字 → 自动总结成纪要

**典型场景**:
```
[走路时按住说话]
用户: 提醒我明天下午三点开会前打印发版报告,
      还有把昨晚 GitHub 那 5 个评论总结一下
Lynn: ✅ 提醒已设
      📋 GitHub 评论总结(基于已抓取的 issue):
      • 3 个用户报告 vllm OOM
      • 2 个用户问 RAG 何时上线
      已发到你笔记本桌面
```

---

## 🔧 客户端更新

### 新增 UI 组件
- **🎤 按住说话按钮** (主输入框旁) · 含波形动画 + 实时转写预览
- **💡 引用记忆 chip** (chat 消息上方) · 展开可看 Lynn 引用了哪几条历史
- **📚 记忆面板** (右侧 sidebar) · 浏览/搜索/管理所有记忆
- **拖拽上传区** (主窗口) · 支持文件 / 文件夹 / 音视频
- **设置 > AI 能力** 新分组 · 控制 RAG/ASR 开关

### 体验改进
- 记忆引用透明可见,**Lynn 不再"凭空回答"**
- 召回延迟 <30ms,几乎无感
- 录音波形 60fps,反馈到位
- 知识库管理支持批量删除 / 重建索引

---

## ⚙️ 服务端更新

### 新增 API (向后兼容)
- `POST /v1/memory/{write,write_batch,recall,list}` · 记忆 CRUD
- `DELETE /v1/memory/{id}` · 软删除
- `POST /v1/knowledge/upload` · SSE 进度流
- `GET /v1/knowledge/list` · 文档管理
- `POST /v1/audio/{transcribe,chat}` · 语音流式接口
- **`/v1/chat/completions` 新增 opt-in `memory` 字段** · 现有客户端不受影响

### 新增依赖
| 服务 | 模型 | 显存占用 |
|---|---|---|
| Embedding | bge-m3 (FP16) | 2.3 GB |
| Reranker | bge-reranker-v2-m3 (FP16) | 2.3 GB |
| ASR | distil-whisper-large-v3 (FP16) | 2.0 GB |
| **小计** | | **6.6 GB** |

### 数据库
- 新增 `~/.lynn/memory.db` (sqlite-vec)
- 自动迁移,首次启动建表
- 1 万条记忆 ≈ 50 MB,3 年增长预估 < 2 GB

---

## 📦 部署

### 推荐: 一键脚本

**有 docker** (推荐 Linux server):
```bash
sudo bash lynn-deploy.sh           # 全装
sudo bash lynn-deploy.sh --no-asr  # 不要语音
sudo bash lynn-deploy.sh --check   # 检查环境
sudo bash lynn-deploy.sh --down    # 卸载
```

**无 docker** (复用 conda env):
```bash
sudo bash lynn-deploy-native.sh    # systemd unit 直接跑 Python
sudo bash lynn-deploy-native.sh --logs  # 看日志
```

### vLLM 兼容性
- v0.77 已与 vLLM `--gpu-memory-utilization 0.85` 配合验证
- **如果你之前是 0.92,部署后请改成 0.85** (脚本自动改 + 备份)
- 4090 48G: 主 LLM + RAG + ASR 同卡共存,余量 1.9 GB (紧但可用)
- 24GB 卡: 建议关 ASR 或上 INT8 量化 (脚本默认 INT8)

---

## ⚠️ Breaking Changes

### 无 API 破坏
所有 v0.76.x 客户端继续工作。`memory.enabled` 默认关闭,旧 client 看不到任何变化。

### 配置层小变化
- `config.yaml` 新增 `memory.enabled` (默认 `false`)
- 启用后,chat/completions 响应会多一个 `memory_used` SSE 事件 (旧 client 自动忽略)

---

## 🐛 已知问题

| Issue | 影响 | workaround |
|---|---|---|
| 4090 48G 余量仅 1.9 GB | 高峰 batch 可能 OOM | 关 Whisper or 降 vllm 0.78 |
| 知识库初次重建索引慢 | 1 万 chunk 耗时 ~10 分钟 | 后台跑,不阻塞 chat |
| Whisper 中文小语种准确率 | 95%+ 但偶有错字 | 可手动修改后再发送 |
| MacOS Apple Silicon | MLX 版本暂未集成 | v0.78 跟进 |

---

## 📊 性能数据

### Memory 召回延迟
| 操作 | 延迟 |
|---|---|
| bge-m3 embed (单 query) | 8 ms |
| sqlite-vec 粗召回 30 条 | 4 ms |
| reranker 精排 30→5 | 12 ms |
| **总召回** | **24 ms** |

### Whisper 转写
| 音频长度 | 转写耗时 | 实时倍率 |
|---|---|---|
| 5 秒 | 0.3 秒 | 16× |
| 30 秒 | 1.2 秒 | 25× |
| 5 分钟 | 9 秒 | 33× |
| 30 分钟会议 | 52 秒 | **35×** |

(distil-large-v3 + 4090 48G + faster-whisper FP16)

### Tool-Calling 24 题
- v0.76.2 (无 RAG): **69/72**
- v0.77 (有 RAG · memory.enabled=true): **70-71/72**
  - 提升来自跨会话工具偏好记忆 (用户偏好 + 历史成功率)

---

## 🛣️ 下一步 (v0.78+)

- 自动关联推荐 ("这跟上次 X 有关"主动提示)
- 微信 / Telegram 语音消息桥接 (转发到 Lynn 自动转写)
- 知识库主动巡查 (新邮件自动 brief)
- MLX 后端 (Apple Silicon 原生)
- 团队共享记忆 (多用户协作)

---

## 🙏 致谢

- BAAI 的 [bge-m3](https://huggingface.co/BAAI/bge-m3) + [bge-reranker-v2-m3](https://huggingface.co/BAAI/bge-reranker-v2-m3)
- Distil-Whisper 团队 [distil-large-v3](https://huggingface.co/distil-whisper/distil-large-v3)
- HuggingFace [TEI](https://github.com/huggingface/text-embeddings-inference) + [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- [sqlite-vec](https://github.com/asg017/sqlite-vec) 让本地向量库变得简单

---

## 📥 下载

- macOS arm64: `Lynn-0.77.0-macOS-arm64.dmg`
- macOS Intel: `Lynn-0.77.0-macOS-x64.dmg`
- Windows x64: `Lynn-0.77.0-Windows-Setup.exe`
- 镜像站: https://lynn.merkyor.com/download
- GitHub: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.0

---

**升级建议**:
- 桌面客户端: 自动检测,直接点更新
- GPU 服务器: 跑 `lynn-deploy.sh` 或 `lynn-deploy-native.sh`,5 分钟搞定
- 配置: 默认安全 (memory off),想体验新能力在设置里勾选
