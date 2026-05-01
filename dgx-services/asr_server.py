"""
Lynn V0.79 Jarvis Runtime — Qwen3-ASR-0.6B HTTP Server
=======================================================

部署位置:/home/merkyor/voice-services/qwen3-asr-spike/asr_server.py
启动方式:
  cd /home/merkyor/voice-services/qwen3-asr-spike
  source .venv/bin/activate
  uvicorn asr_server:app --host 0.0.0.0 --port 18007 --workers 1

DGX 约束(2026-05-01 起铁律 #13):
  - 本服务独占一个 venv,不与 sglang/vllm LLM 同进程混部
  - 模型加载后 VRAM 占用 ~1.5GB,不适用 mem-fraction(transformers eager)
  - 与 LLM 并发时,LLM mem-fraction 上限 0.70(ASR 1.5GB + emotion 1.12GB + CV2 约 4GB 余量)

协议与 server/clients/asr/qwen3-asr.js 对齐:
  POST /transcribe    multipart/form-data { file: audio/* } → { text, language, duration_ms }
  POST /warmup                                               → { ok: true }
  GET  /health                                               → { ok, model, vram_mb }
  POST /transcribe_stream (Phase 2 Day 6 再加,当前骨架只放占位注释)

兜底:
  - 模型加载失败(503s transformers timeout) → 启动失败 exit 1(systemd 会重试)
  - 推理异常 → HTTP 500 + 结构化错误体,由 Lynn ASR fallback chain 兜到 SenseVoice
"""
from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Optional

import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

# 国内镜像优先
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("MODELSCOPE_CACHE", "/home/merkyor/.cache/modelscope")
# 禁用 hf-xet 死锁路径(feedback_hf_large_model_download.md)
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("asr_server")

MODEL_ID = os.environ.get("LYNN_ASR_MODEL_ID", "Qwen/Qwen3-ASR-0.6B")
DEVICE = os.environ.get("LYNN_ASR_DEVICE", "cuda:0")
# 单 request 上限:60s 音频(对话式 AI 足够,防 OOM)
MAX_AUDIO_SECONDS = float(os.environ.get("LYNN_ASR_MAX_AUDIO_SECONDS", "60"))

# ⚠️ 真实雷区(2026-05-01 实测):qwen-asr 0.0.6 只接受完整英文名,不接 ISO code
# 源:pypi.org/project/qwen-asr 页面 language 参数文档
# Lynn 客户端习惯传 "zh"/"en",这里做归一化
_LANG_ALIASES = {
    "zh": "Chinese", "zh-cn": "Chinese", "zh-tw": "Chinese", "cn": "Chinese",
    "en": "English", "en-us": "English", "en-gb": "English",
    "yue": "Cantonese", "zh-yue": "Cantonese", "zh-hk": "Cantonese",
    "ar": "Arabic", "de": "German", "fr": "French", "es": "Spanish",
    "pt": "Portuguese", "id": "Indonesian", "it": "Italian", "ko": "Korean",
    "ru": "Russian", "th": "Thai", "vi": "Vietnamese", "ja": "Japanese",
    "tr": "Turkish", "hi": "Hindi", "ms": "Malay", "nl": "Dutch",
    "sv": "Swedish", "da": "Danish", "fi": "Finnish", "pl": "Polish",
    "cs": "Czech", "fil": "Filipino", "tl": "Filipino", "fa": "Persian",
    "el": "Greek", "hu": "Hungarian", "mk": "Macedonian", "ro": "Romanian",
}


def _normalize_language(value):
    if not value or str(value).lower() in ("auto", ""):
        return None
    v = str(value).strip()
    # 已是英文完整名(首字母大写)直接用
    alias = _LANG_ALIASES.get(v.lower())
    if alias:
        return alias
    # 首字母大写再试一次(Chinese/English 这种用户可能小写传)
    titled = v[:1].upper() + v[1:].lower()
    return titled


_MODEL = None


def _load_model():
    """阻塞加载模型,启动时一次性完成(~503s transformers backend)"""
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    t0 = time.time()
    log.info(f"loading {MODEL_ID} on {DEVICE} (bfloat16, transformers backend) ...")
    try:
        from qwen_asr import Qwen3ASRModel  # type: ignore
    except ImportError as e:
        log.error(f"qwen_asr import failed: {e}. pip install qwen-asr 0.0.6")
        raise
    _MODEL = Qwen3ASRModel.from_pretrained(
        MODEL_ID,
        torch_dtype=torch.bfloat16,
        device_map=DEVICE,
    )
    elapsed = time.time() - t0
    if torch.cuda.is_available():
        vram = torch.cuda.memory_allocated() / 1024 / 1024
        log.info(f"model loaded in {elapsed:.1f}s, VRAM {vram:.0f} MB")
    return _MODEL


def _invoke_transcribe(audio_path: str, language: Optional[str]) -> str:
    """兼容 qwen_asr 0.0.6 的两种调用路径:transcribe / __call__

    PyPI 实测签名:
      model.transcribe(audio, language=None, return_time_stamps=False)
      返回 results[0].language / .text / .time_stamps
    """
    model = _load_model()
    normalized = _normalize_language(language)
    kwargs = {}
    if normalized:
        kwargs["language"] = normalized
    if hasattr(model, "transcribe"):
        try:
            result = model.transcribe(audio=audio_path, **kwargs)
        except TypeError:
            result = model.transcribe(audio_path, **kwargs)
    else:
        result = model(audio_path, **kwargs)
    # qwen_asr 返回 list[Result] 或 str / dict
    if isinstance(result, list) and result:
        first = result[0]
        # Result 对象一般有 .text 属性
        text = getattr(first, "text", None)
        if text is not None:
            return str(text)
        if isinstance(first, dict):
            return str(first.get("text") or first.get("transcript") or first)
        return str(first)
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        return str(result.get("text") or result.get("transcript") or result)
    text = getattr(result, "text", None)
    if text is not None:
        return str(text)
    return str(result or "")


def _duration_ms(wav_bytes: bytes) -> Optional[int]:
    """用 soundfile 拿 duration,失败返回 None 不阻塞"""
    try:
        import soundfile as sf  # type: ignore
        with BytesIO(wav_bytes) as bio:
            info = sf.info(bio)
            return int(info.duration * 1000)
    except Exception:
        return None


# ---------- FastAPI ----------

@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时同步加载(不 lazy,否则首请求 503s 卡死)
    _load_model()
    # 预热:跑一次 dummy 推理,避免首请求 P99 抖动
    try:
        dummy = Path(os.environ.get(
            "LYNN_ASR_WARMUP_WAV",
            "/home/merkyor/.cache/modelscope/hub/models/iic/emotion2vec_plus_base/example/test.wav",
        ))
        if dummy.exists():
            _invoke_transcribe(str(dummy), None)
            log.info("warmup transcribe OK")
        else:
            log.warning(f"warmup wav not found: {dummy}")
    except Exception as e:
        log.warning(f"warmup failed (non-fatal): {e}")
    yield
    # 无需特殊 cleanup,Python 退出时 torch 自会释放


app = FastAPI(title="Lynn Qwen3-ASR", version="0.79.0", lifespan=lifespan)


@app.get("/health")
async def health():
    loaded = _MODEL is not None
    vram_mb = (
        torch.cuda.memory_allocated() / 1024 / 1024
        if loaded and torch.cuda.is_available() else 0
    )
    return {
        "ok": loaded,
        "model": MODEL_ID,
        "device": DEVICE,
        "vram_mb": round(vram_mb, 1),
    }


@app.post("/warmup")
async def warmup():
    _load_model()
    return {"ok": True}


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: Optional[str] = Form(None),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="missing file")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty audio")

    # 安全阈值:> 60s 音频直接拒(对话式 AI 够用,防 OOM)
    dur_ms = _duration_ms(raw)
    if dur_ms is not None and dur_ms > MAX_AUDIO_SECONDS * 1000:
        raise HTTPException(
            status_code=413,
            detail=f"audio too long: {dur_ms}ms > {int(MAX_AUDIO_SECONDS * 1000)}ms",
        )

    # qwen_asr 吃文件路径,临时落盘
    suffix = Path(file.filename).suffix or ".wav"
    with NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(raw)
        tmp_path = tmp.name

    t0 = time.time()
    try:
        text = _invoke_transcribe(tmp_path, language).strip()
    except Exception as e:
        log.exception("transcribe failed")
        raise HTTPException(status_code=500, detail=f"transcribe failed: {e}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    elapsed_ms = int((time.time() - t0) * 1000)
    return JSONResponse({
        "text": text,
        "language": language or "auto",
        "duration_ms": dur_ms,
        "latency_ms": elapsed_ms,
    })


# ---------- Phase 2 Day 6 占位 ----------
# @app.websocket("/transcribe_stream")
# async def transcribe_stream(ws: WebSocket):
#     """
#     qwen_asr 0.0.6 包装:
#       state = model.init_streaming_state()
#       for chunk in pcm_stream:
#           partial = model.streaming_transcribe(state, chunk)
#           yield partial
#     """
#     pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=18007, workers=1)
