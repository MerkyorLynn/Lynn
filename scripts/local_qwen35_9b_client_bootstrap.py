#!/usr/bin/env python3
"""Client-facing bootstrap for Lynn's Qwen3.5-9B Q4_K_M imatrix MTP local llama.cpp provider.

This is meant for the Lynn desktop/client UI, not for end users to run by hand:

1. The client calls `plan` and shows the resulting actions to the user.
2. If the user authorizes local setup, the client calls `execute` with
   `--yes-user-authorized`.
3. The script installs/downloads/registers/smokes through the existing setup
   entrypoint, then optionally starts the persistent local endpoint.

The safety rule is explicit: no install/download/start work happens unless the
caller supplies `--yes-user-authorized`.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SETUP_SCRIPT = ROOT / "scripts" / "local_qwen35_9b_setup.sh"
SERVER_SCRIPT = ROOT / "scripts" / "local_qwen35_9b_q4km_llamacpp_server.sh"
# 2026-05-25: 默认本地模型回到 Qwen3.5-9B Q4_K_M imatrix MTP;4B 仅作低配降级。
DEFAULT_PROVIDER_ID = "local-qwen35-9b-q4km-imatrix"
DEFAULT_MODEL_ID = "qwen35-9b-q4km-imatrix"
DEFAULT_ARTIFACT_ID = "qwen35-9b-q4km-imatrix-gguf"
DEFAULT_MODEL_FAMILY = "Qwen3.5-9B"
DEFAULT_MODEL_FILE_NAME = "Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf"
LEGACY_MODEL_FILE_NAMES = {
    "qwen3.5-9b-q4_k_m-imatrix.gguf",
    "qwen3.5-9b-q4_k_m.gguf",
}
DEFAULT_MODEL_ROOT = Path.home() / "Models" / "Lynn" / "Qwen3.5-9B"
DEFAULT_PROVIDER = Path.home() / ".lynn-engine" / "providers" / f"{DEFAULT_MODEL_ID}-gguf.json"
DEFAULT_PID_FILE = Path.home() / ".lynn-engine" / "run" / f"{DEFAULT_MODEL_ID}.pid"
DEFAULT_LOG_FILE = Path.home() / ".lynn-engine" / "logs" / f"{DEFAULT_MODEL_ID}.client.log"


def _json(payload: dict[str, Any], code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return code


def _which(name: str) -> str | None:
    return shutil.which(name)


def _probe_port(host: str, port: int) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.4)
    try:
        return sock.connect_ex((host, port)) == 0
    finally:
        sock.close()


def _read_provider(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.expanduser().read_text(encoding="utf-8"))
    except Exception:
        return None


def _health(base_url: str) -> bool:
    try:
        root = base_url[:-3] if base_url.endswith("/v1") else base_url.rstrip("/")
        url = root + "/health"
        with urllib.request.urlopen(url, timeout=2) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False


def _models_ready(base_url: str, model: str = DEFAULT_MODEL_ID) -> bool:
    try:
        url = base_url.rstrip("/") + "/models"
        with urllib.request.urlopen(url, timeout=3) as resp:
            if not (200 <= resp.status < 300):
                return False
            data = json.loads(resp.read().decode("utf-8"))
        ids = [
            str(item.get("id", ""))
            for item in data.get("data", [])
            if isinstance(item, dict)
        ]
        return bool(ids) and (model in ids or len(ids) > 0)
    except Exception:
        return False


def _slot_context_min(base_url: str) -> int | None:
    try:
        root = base_url[:-3] if base_url.endswith("/v1") else base_url.rstrip("/")
        with urllib.request.urlopen(root + "/slots", timeout=2) as resp:
            if not (200 <= resp.status < 300):
                return None
            data = json.loads(resp.read().decode("utf-8"))
        values = [
            int(slot.get("n_ctx"))
            for slot in data
            if isinstance(slot, dict) and slot.get("n_ctx") is not None
        ]
        return min(values) if values else None
    except Exception:
        return None


def _wait_ready(base_url: str, *, timeout_sec: float = 180.0) -> bool:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        if _health(base_url) and _models_ready(base_url):
            return True
        time.sleep(1.0)
    return _health(base_url) and _models_ready(base_url)


def _is_complete_gguf_candidate(path: Path) -> bool:
    # ModelScope keeps in-flight downloads under a hidden ._____temp folder.
    # Never treat those partial files as usable GGUFs. Do not reject
    # ~/.lynn/models itself: that is Lynn's canonical in-app model cache.
    parts = path.parts
    if any(part.startswith("._____temp") or part in {".cache", ".tmp"} for part in parts):
        return False
    if path.name.endswith((".part", ".tmp", ".download")):
        return False
    return True


def _iter_gguf_candidates(model_root: Path) -> list[Path]:
    # Also probe the canonical .lynn/models target used by Lynn's in-app
    # downloader (model-downloader.cjs DEFAULT target). Without this, a user
    # who completed the in-app install gets a "no model found" false negative.
    roots = [
        Path.home() / ".lynn" / "models",
        model_root / "q4_k_m",
        model_root,
        Path.home() / "Models",
        Path.home() / "models",
        Path.home() / "Downloads",
    ]
    candidates: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        if not root.exists():
            continue
        for path in sorted(p for p in root.rglob("*.gguf") if _is_complete_gguf_candidate(p)):
            key = str(path.resolve())
            if key in seen:
                continue
            seen.add(key)
            candidates.append(path)
    return candidates


def _is_default_mtp_gguf(path: Path) -> bool:
    name = path.name.lower()
    if name == DEFAULT_MODEL_FILE_NAME.lower():
        return True
    return (
        name.endswith(".gguf")
        and "qwen3.5" in name
        and "9b" in name
        and "q4" in name
        and "k" in name
        and "m" in name
        and "mtp" in name
    )


def _is_legacy_9b_gguf(path: Path) -> bool:
    name = path.name.lower()
    if name in LEGACY_MODEL_FILE_NAMES:
        return True
    return (
        name.endswith(".gguf")
        and "qwen3.5" in name
        and "9b" in name
        and "q4" in name
        and "k" in name
        and "m" in name
        and "mtp" not in name
    )


def _find_gguf(model_root: Path, variant: str) -> Path | None:
    """Search for the current DEFAULT MODEL (Qwen3.5-9B Q4_K_M imatrix MTP)."""
    candidates = [path for path in _iter_gguf_candidates(model_root) if _is_default_mtp_gguf(path)]
    return candidates[0] if candidates else None


def _find_legacy_gguf(model_root: Path) -> Path | None:
    """Find older 9B Q4_K_M files for upgrade messaging only; never use as default."""
    candidates = [path for path in _iter_gguf_candidates(model_root) if _is_legacy_9b_gguf(path)]
    return candidates[0] if candidates else None


def _run_capture(cmd: list[str], timeout: float = 5.0) -> str:
    try:
        return subprocess.run(
            cmd,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=timeout,
        ).stdout
    except Exception:
        return ""


def _total_memory_gib() -> float | None:
    system = platform.system()
    if system == "Darwin":
        out = _run_capture(["sysctl", "-n", "hw.memsize"], timeout=2)
        try:
            return int(out.strip()) / (1024 ** 3)
        except Exception:
            return None
    if system == "Linux":
        try:
            for line in Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) / (1024 ** 2)
        except Exception:
            return None
    if system == "Windows":
        try:
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            return stat.ullTotalPhys / (1024 ** 3)
        except Exception:
            return None
    return None


def _mac_chip_name() -> str | None:
    out = _run_capture(["sysctl", "-n", "machdep.cpu.brand_string"], timeout=2).strip()
    if out:
        return out
    out = _run_capture(["system_profiler", "SPHardwareDataType"], timeout=5)
    for line in out.splitlines():
        if "Chip:" in line or "Processor Name:" in line:
            return line.split(":", 1)[1].strip()
    return None


def _nvidia_gpus() -> list[dict[str, Any]]:
    out = _run_capture([
        "nvidia-smi",
        "--query-gpu=name,memory.total,compute_cap",
        "--format=csv,noheader,nounits",
    ], timeout=4)
    gpus: list[dict[str, Any]] = []
    for row in out.splitlines():
        parts = [p.strip() for p in row.split(",")]
        if len(parts) < 2:
            continue
        try:
            memory_gib = float(parts[1]) / 1024
        except Exception:
            memory_gib = None
        compute_cap = None
        if len(parts) >= 3:
            try:
                compute_cap = float(parts[2])
            except Exception:
                compute_cap = None
        gpus.append({
            "vendor": "nvidia",
            "name": parts[0],
            "memory_gib": memory_gib,
            "compute_capability": compute_cap,
        })
    return gpus


def _hardware_profile() -> dict[str, Any]:
    system = platform.system()
    machine = platform.machine()
    total_gib = _total_memory_gib()
    nvidia = _nvidia_gpus()
    chip = _mac_chip_name() if system == "Darwin" else None
    apple_silicon = system == "Darwin" and machine in {"arm64", "aarch64"}
    warnings: list[str] = []
    blockers: list[str] = []
    upgrade_options: list[dict[str, Any]] = []
    recommendation = "not_recommended"
    profile = {
        "name": "cloud_fallback",
        "label": "继续使用云端兜底",
        "ctx_size": 8192,
        "parallel": 1,
        "gpu_layers": 0,
    }

    best_gpu = max(nvidia, key=lambda g: g.get("memory_gib") or 0, default=None)
    if apple_silicon:
        mem = total_gib or 0
        if mem >= 24:
            recommendation = "recommended"
            profile = {"name": "mac_unified_32k", "label": "Qwen3.5-9B 32K 舒适档", "ctx_size": 32768, "parallel": 1, "gpu_layers": 999}
            upgrade_options.append({
                "id": "qwen35-9b-q4km-imatrix",
                "label": "Qwen3.5-9B Q4_K_M imatrix MTP",
                "profile": "24GB 统一内存+ 推荐 · 质量优先",
                "metrics": [
                    "thinking-on 32K",
                    "MTP 加速",
                    "DGX Spark 单流 36.61→60.95 TPS",
                    "n_max=4 约 +66%",
                    "工具调用 14/15",
                ],
                "reason": "默认质量档；新版 MTP 仓库 + thinking-on，稳定性优先。",
                "modelscope_url": "https://modelscope.cn/models/Merkyor/Qwen3.5-9B-GGUF-imatrix-MTP",
                "download_label": "下载到本机",
                "file_name": "Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf",
                "min_memory_gib": 24,
            })
            if mem >= 32:
                upgrade_options.append({
                    "id": "qwen36-35b-a3b-apex-mtp",
                    "label": "Qwen3.6-35B-A3B APEX-MTP I-Balanced",
                    "profile": "32GB 统一内存+ 推荐 · thinking-on 长链最快",
                    "metrics": [
                        "DGX Spark thinking-on 75-85 TPS",
                        "DGX Spark 数学 84.69 TPS",
                        "DGX Spark 归纳证明 75.53 TPS",
                        "APEX I-Balanced",
                        "24.27 GiB · MTP head",
                    ],
                    "reason": "高端质量档；APEX-MTP 保留官方 MTP head，thinking-on 长链路比 no-MTP 基线提升约 20-30%。",
                    "modelscope_url": "https://modelscope.cn/models/Merkyor/Qwen3.6-35B-A3B-APEX-MTP-GGUF",
                    "download_label": "下载到本机",
                    "file_name": "Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf",
                    "min_memory_gib": 32,
                })
        elif mem >= 16:
            recommendation = "recommended_with_limits"
            profile = {"name": "mac_unified_32k", "label": "Qwen3.5-9B 32K 稳定档", "ctx_size": 32768, "parallel": 1, "gpu_layers": 999}
        elif mem >= 12:
            recommendation = "recommended_with_limits"
            profile = {"name": "mac_unified_16k", "label": "Qwen3.5-9B 16K 入门档", "ctx_size": 16384, "parallel": 1, "gpu_layers": 999}
            warnings.append("12GB 统一内存建议先用 16K；32K thinking 可作为高级选项。")
        elif mem >= 8:
            recommendation = "experimental"
            profile = {"name": "mac_unified_8k", "label": "Qwen3.5-9B 8K 试用档", "ctx_size": 8192, "parallel": 1, "gpu_layers": 999}
            warnings.append("统一内存偏小，只建议试用短上下文；长 thinking 体验可能不稳。")
        else:
            blockers.append("统一内存低于 16GB，不建议默认本地跑 Qwen3.5-9B；请保持默认云端模型或手动选择 4B 降级档。")
    elif best_gpu and (best_gpu.get("memory_gib") or 0) >= 6:
        vram = best_gpu.get("memory_gib") or 0
        cc = best_gpu.get("compute_capability") or 0
        if cc and cc < 7.5:
            recommendation = "experimental"
            profile = {"name": "nvidia_8k_legacy", "label": "NVIDIA Qwen3.5-9B 老卡试用档", "ctx_size": 8192, "parallel": 1, "gpu_layers": 999}
            warnings.append("NVIDIA compute capability 低于 7.5，可能明显慢；不建议作为默认体验。")
        elif vram >= 24:
            recommendation = "recommended"
            profile = {"name": "nvidia_32k", "label": "NVIDIA Qwen3.5-9B 32K 舒适档", "ctx_size": 32768, "parallel": 1, "gpu_layers": 999}
            upgrade_options.append({
                "id": "qwen35-9b-q4km-imatrix",
                "label": "Qwen3.5-9B Q4_K_M imatrix MTP",
                "profile": "24GB 显存+ 推荐 · 质量优先",
                "metrics": [
                    "thinking-on 32K",
                    "MTP 加速",
                    "DGX Spark 单流 36.61→60.95 TPS",
                    "n_max=4 约 +66%",
                    "工具调用 14/15",
                ],
                "reason": "默认质量档；新版 MTP 仓库 + thinking-on，稳定性优先。",
                "modelscope_url": "https://modelscope.cn/models/Merkyor/Qwen3.5-9B-GGUF-imatrix-MTP",
                "download_label": "下载到本机",
                "file_name": "Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf",
                "min_vram_gib": 24,
            })
            if vram >= 32:
                upgrade_options.append({
                    "id": "qwen36-35b-a3b-apex-mtp",
                    "label": "Qwen3.6-35B-A3B APEX-MTP I-Balanced",
                    "profile": "32GB 显存+ 推荐 · thinking-on 长链最快",
                    "metrics": [
                        "DGX Spark thinking-on 75-85 TPS",
                        "DGX Spark 数学 84.69 TPS",
                        "DGX Spark 归纳证明 75.53 TPS",
                        "APEX I-Balanced",
                        "24.27 GiB · MTP head",
                    ],
                    "reason": "高端质量档；APEX-MTP 保留官方 MTP head，thinking-on 长链路比 no-MTP 基线提升约 20-30%。",
                    "modelscope_url": "https://modelscope.cn/models/Merkyor/Qwen3.6-35B-A3B-APEX-MTP-GGUF",
                    "download_label": "下载到本机",
                    "file_name": "Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf",
                    "min_vram_gib": 32,
                })
        elif vram >= 16:
            recommendation = "recommended_with_limits"
            profile = {"name": "nvidia_32k", "label": "NVIDIA Qwen3.5-9B 32K 稳定档", "ctx_size": 32768, "parallel": 1, "gpu_layers": 999}
        else:
            recommendation = "recommended_with_limits"
            profile = {"name": "nvidia_16k", "label": "NVIDIA Qwen3.5-9B 16K 入门档", "ctx_size": 16384, "parallel": 1, "gpu_layers": 999}
            warnings.append("8-12GB 显存不建议默认 9B；可试 16K/单并发或手动选择 4B 降级档。")
    elif system == "Linux" and not best_gpu:
        blockers.append("未检测到 NVIDIA GPU；CPU 路径可以跑但体验较慢，默认不推荐。")
    elif system == "Windows":
        blockers.append("Windows 首发仍在补齐；当前建议使用云端兜底或手动 llama.cpp。")
    else:
        blockers.append("当前硬件未达到本地 Qwen3.5-9B 默认启用条件 (16GB+ 可试,24GB+ 推荐)。")

    return {
        "platform": system,
        "machine": machine,
        "chip": chip,
        "total_memory_gib": round(total_gib, 2) if total_gib else None,
        "gpus": nvidia,
        "recommendation": recommendation,
        "recommended_runtime": profile,
        "warnings": warnings,
        "blockers": blockers,
        "can_enable": recommendation in {"recommended", "recommended_with_limits", "experimental"},
        "upgrade_options": upgrade_options,
    }


def build_plan(args: argparse.Namespace) -> dict[str, Any]:
    model_root = Path(args.model_root).expanduser()
    provider_path = Path(args.provider_config).expanduser()
    host = args.host
    port = int(args.port)
    base_url = f"http://{host}:{port}/v1"
    provider = _read_provider(provider_path)
    gguf = _find_gguf(model_root, args.variant)
    legacy_gguf = None if gguf else _find_legacy_gguf(model_root)
    needs_model_upgrade = gguf is None and legacy_gguf is not None
    llama_server = _which("llama-server") or _which("llama.cpp-server")
    has_brew = _which("brew") is not None
    running = _probe_port(host, port) and _health(base_url) and _models_ready(base_url)
    hardware = _hardware_profile()

    actions: list[dict[str, Any]] = []
    if not llama_server:
        actions.append({
            "id": "install_runtime",
            "label": "Install llama.cpp runtime",
            "requires_user_authorization": True,
            "method": "homebrew" if platform.system() == "Darwin" and has_brew else "manual_or_app_managed",
        })
    if gguf is None:
        actions.append({
            "id": "download_model",
            "label": "Upgrade Qwen3.5-9B to Q4_K_M imatrix MTP GGUF" if needs_model_upgrade else "Download Qwen3.5-9B Q4_K_M imatrix MTP GGUF",
            "requires_user_authorization": True,
            "approx_download_gib": 5.38,
            "artifact_id": DEFAULT_ARTIFACT_ID,
            "expected_file_name": DEFAULT_MODEL_FILE_NAME,
            "replaces": str(legacy_gguf) if legacy_gguf else None,
        })
    if provider is None:
        actions.append({
            "id": "register_provider",
            "label": "Write Lynn local-provider config",
            "requires_user_authorization": False,
            "path": str(provider_path),
        })
    if not running:
        actions.append({
            "id": "smoke_and_start",
            "label": "Smoke local endpoint and start server",
            "requires_user_authorization": True,
            "base_url": base_url,
        })

    return {
        "schema_version": "lynn-qwen35-local-client-bootstrap-plan-v1",
        "decision": "already_ready" if not actions else "needs_user_authorization",
        "default_provider": "mimo",
        "fallback_provider": "mimo",
        "target_provider": DEFAULT_PROVIDER_ID,
        "base_url": base_url,
        "model": DEFAULT_MODEL_ID,
        "model_root": str(model_root),
        "provider_config": str(provider_path),
        "observed": {
            "platform": platform.system(),
            "machine": platform.machine(),
            "llama_server": llama_server,
            "gguf": str(gguf) if gguf else None,
            "legacy_gguf": str(legacy_gguf) if legacy_gguf else None,
            "needs_model_upgrade": needs_model_upgrade,
            "expected_file_name": DEFAULT_MODEL_FILE_NAME,
            "provider_config_exists": provider is not None,
            "endpoint_running": running,
            "homebrew_available": has_brew,
        },
        "hardware": hardware,
        "actions": actions,
        "user_authorization_required": any(a.get("requires_user_authorization") for a in actions),
        "notes": [
            "The client must keep MIMO active until execute succeeds and smoke passes.",
            "The user authorizes the plan in the client UI; the user should not paste shell commands.",
        ],
    }


def _stable_cwd() -> str:
    """Use a directory that will not disappear if the app bundle is replaced."""
    return str(Path.home())


def _run_checked(cmd: list[str], *, env: dict[str, str] | None = None) -> None:
    subprocess.run(cmd, cwd=_stable_cwd(), env=env, check=True)


def _read_env_file_value(env_file: Path, key: str) -> str | None:
    try:
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            prefix = f"export {key}="
            if not line.startswith(prefix):
                continue
            value = line[len(prefix):].strip()
            if len(value) >= 2 and value[0] == value[-1] == '"':
                value = value[1:-1]
            return value
    except Exception:
        return None
    return None


def _listener_pid(port: int) -> int | None:
    out = _run_capture(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"], timeout=2).strip()
    if not out:
        return None
    try:
        return int(out.splitlines()[0].strip())
    except Exception:
        return None


def _start_server(env_file: Path, pid_file: Path, log_file: Path) -> dict[str, Any]:
    host = os.environ.get("LYNN_QWEN35_HOST", "127.0.0.1")
    port = int(os.environ.get("LYNN_QWEN35_PORT", "18099"))
    base_url = f"http://{host}:{port}/v1"
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    log_file.parent.mkdir(parents=True, exist_ok=True)
    desired_ctx = None
    try:
        desired_ctx = int(_read_env_file_value(env_file, "CTX_SIZE") or "0") or None
    except Exception:
        desired_ctx = None
    if _probe_port(host, port) and _health(base_url):
        slot_ctx = _slot_context_min(base_url)
        pid = _listener_pid(port)
        if desired_ctx and slot_ctx and slot_ctx < desired_ctx and pid:
            try:
                os.kill(pid, 15)
            except Exception:
                pass
            time.sleep(1.0)
            if _probe_port(host, port):
                try:
                    os.kill(pid, 9)
                except Exception:
                    pass
            time.sleep(0.5)
        elif desired_ctx and slot_ctx and slot_ctx < desired_ctx:
            return {
                "reused": False,
                "pid": None,
                "pid_file": str(pid_file),
                "log_file": str(log_file),
                "base_url": base_url,
                "warning": f"existing endpoint slot context {slot_ctx} is below desired {desired_ctx}, but listener pid was not found",
            }
        else:
            if pid:
                pid_file.write_text(str(pid) + "\n", encoding="utf-8")
            return {
                "reused": True,
                "pid": pid,
                "pid_file": str(pid_file),
                "log_file": str(log_file),
                "base_url": base_url,
                "slot_context": slot_ctx,
            }
    shell = (
        f"set -euo pipefail; "
        f"source {shlex_quote(str(env_file))}; "
        f"exec bash {shlex_quote(str(SERVER_SCRIPT))}"
    )
    log_handle = log_file.open("ab")
    proc = subprocess.Popen(
        ["bash", "-lc", shell],
        cwd=_stable_cwd(),
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    pid_file.write_text(str(proc.pid) + "\n", encoding="utf-8")
    return {"reused": False, "pid": proc.pid, "pid_file": str(pid_file), "log_file": str(log_file), "base_url": base_url}


def shlex_quote(value: str) -> str:
    import shlex

    return shlex.quote(value)


def execute(args: argparse.Namespace) -> int:
    if not args.yes_user_authorized:
        return _json({
            "schema_version": "lynn-qwen35-local-client-bootstrap-result-v1",
            "ok": False,
            "error": "missing_user_authorization",
            "message": "Client must pass --yes-user-authorized after the user approves local setup.",
            "plan": build_plan(args),
        }, 2)

    model_root = Path(args.model_root).expanduser()
    provider_path = Path(args.provider_config).expanduser()
    env_file = model_root / "lynn-qwen35-9b.env"
    setup_cmd = [
        "bash",
        str(SETUP_SCRIPT),
        "--variant",
        args.variant,
        "--download",
        "--smoke",
        "--model-root",
        str(model_root),
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--env-file",
        str(env_file),
    ]
    plan_now = build_plan(args)
    runtime = plan_now.get("hardware", {}).get("recommended_runtime", {})
    ctx_size = args.ctx_size or runtime.get("ctx_size")
    parallel = args.parallel or runtime.get("parallel")
    gpu_layers = args.gpu_layers or runtime.get("gpu_layers")
    if ctx_size:
        setup_cmd += ["--ctx", str(ctx_size)]
    if parallel:
        setup_cmd += ["--parallel", str(parallel)]
    if gpu_layers is not None:
        setup_cmd += ["--gpu-layers", str(gpu_layers)]
    if args.install_runtime:
        setup_cmd.append("--install-runtime")

    env = os.environ.copy()
    env["LYNN_PROVIDER_CONFIG"] = str(provider_path)
    env["LYNN_QWEN35_HOST"] = args.host
    env["LYNN_QWEN35_PORT"] = str(args.port)
    _run_checked(setup_cmd, env=env)

    start_info = None
    if args.start:
        start_info = _start_server(env_file, Path(args.pid_file).expanduser(), Path(args.log_file).expanduser())
        if not _wait_ready(f"http://{args.host}:{args.port}/v1"):
            final_plan = build_plan(args)
            return _json({
                "schema_version": "lynn-qwen35-local-client-bootstrap-result-v1",
                "ok": False,
                "error": "endpoint_not_ready",
                "message": "llama.cpp started but did not pass /health and /v1/models readiness in time.",
                "runtime_profile": runtime,
                "provider_config": str(provider_path),
                "env_file": str(env_file),
                "started": start_info,
                "status": final_plan,
            }, 4)

    final_plan = build_plan(args)
    return _json({
        "schema_version": "lynn-qwen35-local-client-bootstrap-result-v1",
        "ok": True,
        "runtime_profile": runtime,
        "provider_config": str(provider_path),
        "env_file": str(env_file),
        "started": start_info,
        "status": final_plan,
    })


def status(args: argparse.Namespace) -> int:
    return _json(build_plan(args))


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_common(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--model-root", default=str(DEFAULT_MODEL_ROOT))
        sp.add_argument("--provider-config", default=str(DEFAULT_PROVIDER))
        sp.add_argument("--variant", choices=["imatrix", "default"], default="imatrix")
        sp.add_argument("--host", default="127.0.0.1")
        sp.add_argument("--port", default="18099")
        sp.add_argument("--pid-file", default=str(DEFAULT_PID_FILE))
        sp.add_argument("--log-file", default=str(DEFAULT_LOG_FILE))
        sp.add_argument("--ctx-size", type=int, default=None)
        sp.add_argument("--parallel", type=int, default=None)
        sp.add_argument("--gpu-layers", type=int, default=None)

    add_common(sub.add_parser("plan", help="Return the client authorization plan JSON."))
    add_common(sub.add_parser("status", help="Return current local-provider status JSON."))

    ex = sub.add_parser("execute", help="Execute the authorized plan.")
    add_common(ex)
    ex.add_argument("--yes-user-authorized", action="store_true")
    ex.add_argument("--install-runtime", action="store_true", default=True)
    ex.add_argument("--no-install-runtime", action="store_false", dest="install_runtime")
    ex.add_argument("--start", action="store_true", help="Start persistent endpoint after setup smoke.")

    args = p.parse_args()
    if args.cmd == "execute":
        return execute(args)
    return status(args)


if __name__ == "__main__":
    raise SystemExit(main())
