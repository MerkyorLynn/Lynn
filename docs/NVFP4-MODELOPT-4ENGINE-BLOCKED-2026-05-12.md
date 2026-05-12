# NVFP4 modelopt_fp4 4-engine serving blocked postmortem (2026-05-12)

> **TL;DR**: NVIDIA Model Optimizer 0.43 给 Qwen3.6-35B-A3B 做 NVFP4 量化,PTQ 一气呵成,24GB 完整 ckpt 出炉(精确 `25,615,693,816 bytes`)— 然后 SGLang dev-cu13、SGLang v0.5.9 stable、vLLM aeon-7 fork、TensorRT-LLM 1.2.x 四个 backend 用四种不同的方式拒绝加载它。**这不是哪个框架不行,是 `qwen3_5_moe × modelopt_fp4 × Blackwell sm_120/121 × 多模态 wrapper` 四维同时落进生态各自的空档。** 下文是 14 个具体坑 + 我们为什么决定不修上游、自己写 Lynn engine 的 NVFP4 loader。

---

## 我们以为问题是"怎么量化"

5/15 要 ship 一版 Qwen3.6-35B-A3B 的 NVFP4 量化模型。NVFP4 是 NVIDIA Blackwell 架构(sm_120/121)上的 4-bit 浮点格式,理论 FP16/BF16 的 1/4 显存、配套 tensor core 加速。两条主流路线:

1. **`compressed-tensors nvfp4-pack-quantized`(v8-RTN)** — vLLM/SGLang 老牌 4-bit pack 格式,我们之前已经在 SGLang dev-cu13 nightly 上 production 跑了两周。
2. **`modelopt_fp4`(NVIDIA Model Optimizer 0.43+ 输出)** — 走 NVIDIA 官方量化栈,内置 SmoothQuant/AWQ/per-tensor scale,理论更准,且 TensorRT-LLM 原生认。

我们决定升 modelopt_fp4 主路。RTX PRO 6000 Workstation(sm_120,96GB GDDR7)做 PTQ,`hf_ptq.py` 一次跑通,**24GB safetensors + `hf_quant_config.json` 全齐**,`{"quant_algo":"NVFP4", "kv_cache_quant_algo":"FP8", "group_size":16}` 三件套精确。看起来 5/15 ship 妥了。

## 然后 4 个 backend 用 4 种姿势拒绝它

### Backend 1:SGLang `dev-cu13`(production 主镜像)

modelopt 量化时把模型 architecture 从原始 `Qwen3_5MoeForConditionalGeneration`(多模态)改写成 `Qwen3_5MoeForCausalLM`(strip vision tower 后的纯文本)。直接撞墙:

```
ValueError: Qwen3_5MoeForCausalLM has no SGlang implementation
and the Transformers implementation is not compatible with SGLang.
```

SGLang dev-cu13 ModelRegistry 只注册了 `ConditionalGeneration` 一个 arch。

把 `config.json architectures` 改回原始 `ConditionalGeneration`,SGLang 接受了,进了 `ModelOptModelLoader`,识别 `modelopt + nvfp4`,**自动选了 `SM120/Blackwell fp4-gemm-backend=flashinfer_cudnn`**。然后:

```
File "sglang/srt/layers/linear.py", line 858, in weight_loader_v2
    param.load_merged_column_weight(...)
File "sglang/srt/layers/parameter.py", line 218, in load_merged_column_weight
    assert param_data.shape == loaded_weight.shape
```

SGLang 把 `q_proj/k_proj/v_proj` fuse 成 `qkv_proj`,期望各 shard 形状切到 fused tensor 的 column slice。**modelopt 序列化的 NVFP4 weight + per-group scale shape 跟 fused layout 切片不对齐**。

### Backend 2:SGLang `v0.5.9` 稳定版

35.6GB image 拉下来一查:

- `SGLANG_VER: 0.5.9`
- `transformers 4.57.1` → `qwen3_5_moe in CONFIG_MAPPING_NAMES? False`
- **`modelopt` 包根本没装**(只有 dev-cu13 nightly 才有)

完全不能加载 modelopt ckpt。

### Backend 3:vLLM(`aeon-7/vllm-aeon-ultimate-dflash:qwen36-v3` fork)

aeon-7 fork ModelRegistry 同时注册了 `Qwen3_5MoeForCausalLM` ✓ 和 `Qwen3_5MoeForConditionalGeneration` ✓ — 是 4 个 backend 里唯一两个 arch 都登的。但加载权重时:

```
File "vllm/model_executor/models/qwen3_5.py", line 410, in load_weights
    param = params_dict[name_mapped]
KeyError: 'language_model.layers.0.mlp.experts.w2_input_scale'
```

vLLM aeon-7 loader 在找**融合命名**的 scale tensor — `experts.w2_input_scale`(单个 scale 给所有 experts)。**而 modelopt 输出的是 per-expert**:`experts.0.w2.input_scale`、`experts.1.w2.input_scale`、... 一直到 128 号专家。

反转挺刺激 — 第一直觉以为是 modelopt 输错了,结果是 vLLM aeon-7 loader 实现没跟上 modelopt 的标准输出格式。

### Backend 4:TensorRT-LLM 1.2.x(`nvcr.io/nvidia/tritonserver:26.03/26.04-trtllm-python-py3`)

NVIDIA 官方组合,memory 里曾记"TRT-LLM 1.3 first-class modelopt_fp4 支持" — NGC 上稳定版是 1.2.0/1.2.1(26.03/26.04 镜像)。启动后非常顺:

```
[TRT-LLM] [I] Found hf_quant_config.json, pre-quantized checkpoint is used.
[TRT-LLM] [I] Setting quant_algo=NVFP4 form HF quant config.
[TRT-LLM] [I] Setting kv_cache_quant_algo=FP8 form HF quant config.
[TRT-LLM] [I] Setting group_size=16 from HF quant config.
```

**TRT-LLM 1.2.x 原生认 modelopt 的 hf_quant_config!** 4 个 backend 里唯一不需要任何 config 改动就读懂量化参数的。然后:

```
ValueError: The checkpoint you are trying to load has model type `qwen3_5_moe`
but Transformers does not recognize this architecture.
KeyError: 'qwen3_5_moe'
```

容器 `transformers 4.57.3` 跟 SGLang v0.5.9 同样的根因。

**这次治根。** aliyun pypi mirror 装 `transformers==5.8.0`,`qwen3_5_moe in CONFIG_MAPPING_NAMES? True`。重启 trtllm-serve:

```
ImportError: cannot import name 'AutoModelForVision2Seq' from 'transformers'
```

`AutoModelForVision2Seq` 在 transformers 5.x 改名 `AutoModelForImageTextToText`。sed-patch 修。重启:

```
ImportError: cannot import name 'get_parameter_device' from 'transformers.modeling_utils'
```

`get_parameter_device` 又被移走。**TRT-LLM 1.2.x 是 pin 在 transformers 4.57 之上的 — 升 5.8 破坏一连串 import,patch 是无底洞。**

## 这不是哪个框架的问题,是四维交叉

四个 backend 缺的不一样,但根因都在同一片"生态交界处":

| 维度 | 现状(2026-05) |
|---|---|
| `qwen3_5_moe` model_type | 2025 末才登记,transformers ≥ 5.2 才认 |
| `modelopt_fp4` 序列化格式 | NVIDIA Model Optimizer 0.43(2025-末)输出,各 loader 处理方式不一 |
| Blackwell sm_120 / sm_121 | 2024-2025 才量产,sgl_kernel、flash-attn、cu130 wheel 全在追 |
| 多模态 wrapper(Qwen3.5-VL 派生) | `ConditionalGeneration` ↔ `ForCausalLM` 双 entry,modelopt 改写一次,backend loader 没跟上 |

任何一维单独出现都不是问题。**问题是 Qwen3.6-A3B + modelopt + Blackwell + 多模态衍生 同时把模型推到生态盲区**:

- **SGLang dev-cu13**:沿 modelopt 路径但 fused QKV shape 不齐
- **SGLang v0.5.9 stable**:压根没装 modelopt + transformers 4.57
- **vLLM aeon-7 fork**:registry 双 arch 但 loader 期望融合 scale(我们给的是 per-expert)
- **TRT-LLM 1.2.x**:认 modelopt 但 pin 旧 transformers + 升级一升一片

每个 backend 都朝"对的方向"走,只是没走到同一个点上。

## 完整 14 trap 清单

### 量化端(modelopt PTQ 自身,trap #1-6)

| # | Trap | Where | Fix |
|---|---|---|---|
| 1 | `pip install nvidia-modelopt[hf]` 强制 `transformers 5.x → 4.57.6` | install | 装完 force re-pin `transformers==5.8.0 huggingface_hub==1.14.0` |
| 2 | `git clone TRT-Model-Optimizer` 大陆超时 ~130s | TRT-MO fetch | 用 codeload tarball `https://codeload.github.com/NVIDIA/TensorRT-Model-Optimizer/tar.gz/refs/tags/0.43.0`,解压目录 `Model-Optimizer-0.43.0` |
| 3 | TRT-MO `main` branch `hf_ptq.py` 引用 `EagleOfflineDataCollator`,PyPI 0.43.0 modelopt 没这类 | branch mismatch | TRT-MO checkout 必须 pin `tag/0.43.0` |
| 4 | HF Hub 大陆超时 `client has been closed` | calibration | `export HF_ENDPOINT=https://hf-mirror.com` |
| 5 | `nvidia/Nemotron-Post-Training-Dataset-v2 is a gated dataset` | calibration | 接 Nemotron license 加 `HF_TOKEN`,或 `--dataset cnn_dailymail` 跳过 |
| 6 | inline `mtq.quantize()` + `export_hf_checkpoint()` 报 `TypeError: 'NoneType' object is not iterable` at `is_multimodal_model` | export | 用 `hf_ptq.py` CLI(handles multimodal class registration) |

### Serving 端(trap #7-14)

| # | Trap | Fix |
|---|---|---|
| 7 | SGLang stable v0.5.9 / nightly v0.5.11 `sgl_kernel` PyPI wheel 只 ship `sm_90 + sm_100`,**`sm_120/` 不存在** | 等上游 sm_120 binary,或从 source 编译 |
| 8 | vLLM 0.20.2 hard-require `flash_attn.ops.triton.rotary`,**`torch 2.11 + cu130 + py3.12` 没 PyPI flash-attn wheel** | 等 wheel 发布 |
| 9 | vLLM 0.20.2 ModelRegistry 只注册 `Qwen3_5MoeForConditionalGeneration`,改写 `Qwen3_5MoeForCausalLM` 无效(force-init vision tower) | 等 vLLM 单独注册 `ForCausalLM` |
| 10 | Spark sm_121 + SGLang dev-cu13 进 `ModelOptModelLoader` 选 `flashinfer_cudnn`,死在 `load_merged_column_weight` shape assert | 等 SGLang upstream loader 适配 modelopt fused/per-expert |
| 11 | `lmsysorg/sglang:v0.5.9` stable **不装 `modelopt` 包** + `transformers 4.57.1` 不认 `qwen3_5_moe` | 等 SGLang stable 同时升 transformers + 装 modelopt |
| 12 | `nvcr.io/nvidia/tritonserver:26.03/26.04-trtllm-python-py3` 含 TRT-LLM 1.2.0/1.2.1 + `transformers 4.57.3` hard-pin。升 5.8 引发 `AutoModelForVision2Seq → ImageTextToText` rename + `get_parameter_device` 搬家 cascade,patch 无底洞 | 等 TRT-LLM 1.3 pin transformers ≥ 5.2 |
| 13 | docker `restart=always`/`unless-stopped` 让 `docker stop` 自复活,production 抢回 GPU → TRT-LLM `CUDA stream OOM` | test runner Phase 2:`docker update --restart=no` → `docker stop` → 验真停;Phase 4.5 restore:`docker start` + `docker update --restart=<original>` |
| 14 | SGLang dev-cu13 只认 `Qwen3_5MoeForConditionalGeneration`,modelopt 改写后 `ForCausalLM` 不认 | 改 config.json `architectures` 回 ConditionalGeneration,SGLang 才会走 ModelOptModelLoader |

## 为什么回退 `v8-RTN compressed-tensors` 是工程正确决策

5/15 ship 不能 block 在生态对齐上。判断:

1. **`compressed-tensors nvfp4-pack-quantized`(v8-RTN)** 在 SGLang dev-cu13 nightly 上 production 流量两周,稳定
2. **`modelopt_fp4`** 标 `candidate / ecosystem-not-ready`,**不阻塞 5/15 ship**
3. 等上游 4-8 周(2026-06 ~ 07)集成对齐后再切

HF 两个 repo 显式分开:

- `nerkyor/Qwen3.6-35B-A3B-NVFP4-v8-RTN`:production,已 SGLang dev-cu13 验证
- `nerkyor/Qwen3.6-35B-A3B-NVFP4-modelopt`(待发):**candidate**,model card 顶部三色状态盘明确标 "PTQ ✅ verified / Spark serving ❌ blocked / R6000 serving ❌ blocked",附 14 个 trap 全清单

**不让 candidate 假装 production 是这次最重要的原则。** 一篇文章打动用户最便宜的方式是把 candidate 包装成 production — 我们拒绝这样做。5/16 用户跑不通就回来骂街,信用一次性消耗。HF 上"我们试过它,这是 14 个坑,不要踩"的 candidate 比"这是最新成果,快来用"的 production-fake 价值高一个数量级。

## Lynn engine 怎么搞 NVFP4

**不跟上游 vLLM/SGLang/TRT-LLM 的 NVFP4 集成节奏。** 4-8 周等不起,且等了之后我们对内部权重格式仍然是黑盒。决定走 native path:

### Stage 0 — 5/15 ship 完全解耦(✓ 已锁定)
production 走 v8-RTN,modelopt_fp4 留 candidate。

### Stage 1 — `loader.py` fail-loud + 双格式识别
- **遇到 NVFP4 不能 silent fallthrough** — 必须显式 raise / log。silent fallback 到 BF16 是最大的坑
- 同时支持 `compressed-tensors nvfp4-pack-quantized` 和 `modelopt_fp4`
- 统一成内部 canonical spec:
  ```
  packed_uint8       (FP4 packed, 2x 4-bit/byte)
  weight_scale       (F8_E4M3 per-group, group_size=16)
  global_scale       (F32 per-tensor)
  input_scale        (F32 per-tensor)
  ```

### Stage 2 — 第一版 offline dequant 到 BF16
**目标不是快,是证明对。** 消灭 unpack / scale broadcast / key mapping / layer parity 这 80% 的坑。

### Stage 3 — 硬验证链(不许跳)
1. 单 tensor unit test:packed → fp4 → BF16,对 shape / scale / checksum
2. 单 layer forward parity:atol ≤ 1e-3
3. 5-token exact / near-exact
4. **N ≥ 20 multi-prompt gate** — single-prompt PASS **不背书**

### Stage 4 — 最后才碰 native NVFP4 GEMM
expert FFN `Linear` 替换成 NVFP4 grouped GEMM。**不在 Stage 1-3 都通之前碰这层** — 同时面对格式 / scale / router / kernel 四层不确定性,任何一层错都会被另外三层掩盖。

## 总结

**任何团队想把 2025 末才出的 model_type + 2025 末才出的量化格式 + 2024 末才量产的硬件 跑在 2025 中开发的 backend 上,都会撞到这片生态空档。** 这篇坑表打开就能用,比一篇"我们的 NVFP4 跑到 1000 tokens/s"的 benchmark 稿子有价值得多 — benchmark 复现成本高,坑表复现成本零。

更重要的是:**这次踩坑让我们看清 Lynn engine 的位置不是"再做一个 vLLM",而是"做一个让格式正确性比性能优先的引擎"。** 上游卷性能(谁的 token/s 更高),Lynn engine 卷正确性(parity atol 1e-3 / 不 silent fallback / N ≥ 20 gate)。5/15 这种 deadline 下显得"慢",但 6/15、7/15 上游 ecosystem 还在自己卷的时候,我们已经稳了。

——

附两个 HF repo:

- production: https://huggingface.co/nerkyor/Qwen3.6-35B-A3B-NVFP4-v8-RTN
- candidate(14 trap 全清单): https://huggingface.co/nerkyor/Qwen3.6-35B-A3B-NVFP4-modelopt (待发布)

上一篇:《BF16 bmm 假绿:Lynn engine Phase 3.2 推理引擎踩坑复盘》— 测试反馈不能撒谎
本篇主题:框架兼容性不能撒谎(silent fallback 是更深的"假绿")
