# Spike 04 — tonarino webrtc-audio-processing N-API binding ★

> **Foundation Gate 关键路径**。这个 spike 决定 V0.79 能否走 Tier 1 全双工 Jarvis。
>
> 验证:
> 1. macOS arm64 能编出 `.node` 文件吗?
> 2. `cargo build --release` 是否会卡 abseil / meson / autotools 依赖?
> 3. `process_render_frame` + `process_capture_frame` 调用 OK?
> 4. 最初 ERLE 粗估 > 0(说明 AEC 起作用)?

## 依赖前置

### macOS arm64

```bash
brew install meson ninja pkg-config abseil
# tonarino webrtc-audio-processing v2.0.4 要 abseil-cpp,
# meson + ninja 是 webrtc-audio-processing C++ 部分的 build system

# Rust toolchain (via rustup)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add aarch64-apple-darwin
```

### Windows x64

```powershell
# 装 VS Build Tools (含 C++ 编译器 + meson)
# choco install meson ninja
# rustup target add x86_64-pc-windows-msvc
# ⚠️ Windows 上 webrtc-audio-processing 已知有 'atomic' link issue
#    见 mesonbuild/abseil-cpp issue #10
```

### Linux

```bash
sudo apt install meson ninja-build libabsl-dev pkg-config
rustup target add x86_64-unknown-linux-gnu
```

## 跑法

```bash
cd spike/04-tonarino-aec-napi

# 1. 装 napi CLI(node 工具,用于 build .node)
npm install

# 2. Rust release build(可能要 5-10 分钟,首次 fetch + 编译 webrtc-audio-processing)
cargo build --release

# 3. napi-rs 把 .dylib 包装成 .node
npm run build

# 4. 跑 hello world
npm test
# 预期输出:
#   AEC processor: sample_rate=16000Hz channels=1 samples/frame=160
#   render frame OK
#   capture frame OK,output sample [0..3]: ...
#   粗估 mic→cleaned 能量降低: XX.XX dB
#   ✓ Spike 04 hello world 通过
```

## 验收标准(Foundation Gate 关键)

| 指标 | 目标 | 不达标含义 |
|------|------|-----------|
| **macOS arm64 编译成功** | 必须过 | macOS arm64 是 Lynn 第一目标平台,过不了 = Tier 1 立刻降级 |
| **macOS x64 编译成功** | 应过 | 不过则 Intel Mac 用户用 Tier 2/3 |
| **Windows x64 编译成功** | 期望过 | 不过则 Win 用户走 SpeexDSP WASM 兜底 |
| **Linux x64 编译成功** | 期望过 | 不过对 Lynn 影响小(Linux 用户少) |
| `cargo build --release` 总时间 | < 10 分钟 | 长于此说明 deps 异常,可能 fetch 卡 |
| `npm test` 输出粗估 ERLE | > 5 dB | < 5 说明 reference signal 完全没起作用,可能 API 用错 |
| `.node` 文件大小 | < 5 MB | 超过说明 webrtc-audio-processing 静态链了一堆没必要的东西 |

## 失败模式记录

```
macOS arm64 (M-series, brew):     - 待测
macOS x64 (Intel Mac):           - 待测
Windows 11 x64 (VS Build Tools): - 待测
Ubuntu 24.04 x64:               - 待测
```

每次失败请补:
- 错误信息 stderr
- cargo / npm 版本
- 依赖版本 (`brew list abseil` 等)
- 解决方法或绕过

## 已知坑

- **abseil 兼容性**:tonarino sys crate 用的是 webrtc-audio-processing v0.3 老版本(看 sys crate 文档),`Cargo.toml` 锁 v2.0.4 可能要更新 sys crate
- **macOS xcrun**:首次 `cargo build` 会触发 macOS 装 Command Line Tools,如果没装会卡
- **Windows atomic 链接**:已知 issue,可能要手动 patch CMakeLists.txt 加 `-latomic`
- **Apple Silicon Rosetta**:确保 cargo 跑的是 native arm64 版,不是 Rosetta 模拟

## prebuildify 三平台分发(spike 通过后)

```bash
# 装 prebuildify
npm i -D prebuildify

# 三平台 cross-build(在对应机器上跑)
npx prebuildify --napi --strip --tag-armv

# 上传 prebuilds/ 文件夹到 Lynn npm 包,用户首启零编译
```

## 下一步

- ✅ macOS arm64 编出 + hello world 通过 → Spike 05 实测 ERLE
- ✅ 三平台都过 → **Tier 1 准入,V0.79 走全双工 Jarvis**
- ⚠️ 仅 macOS 过 → **Tier 2 部分平台降级**,Win/Linux 走 WASM SpeexDSP
- ❌ macOS arm64 都不过 → **Tier 3 half-duplex** 或 Tier 4 V0.78++

记录到 [`docs/PLAN-v0.79-JARVIS-MODE.md`](../../docs/PLAN-v0.79-JARVIS-MODE.md) v2.3.1。
