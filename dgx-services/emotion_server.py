"""
Lynn V0.79 Jarvis Runtime — emotion2vec+ base HTTP Server
=========================================================

部署位置:/home/merkyor/voice-services/emotion2vec-spike/emotion_server.py
启动方式:
  cd /home/merkyor/voice-services/emotion2vec-spike
  source .venv/bin/activate
  uvicorn emotion_server:app --host 0.0.0.0 --port 18008 --workers 1

协议与 server/clients/ser/emotion2vec-plus.js 对齐:
  POST /classify  multipart/form-data { file: audio/* }
    → { labels, scores, top1, top1_score, latency_ms }
  POST /warmup                                          → { ok }
  GET  /health                                          → { ok, model, vram_mb }

约束:
  - FunASR `iic/emotion2vec_plus_base`,纯 PyTorch eager(模型 1.12GB checkpoint)
  - 推理稳态 P50 70ms / P99 < 100ms(warmup 后),首推 P99 514ms
  - Lynn voice-ws 应该在 session 启动时调 /warmup 一次
  - 只跑 4s 音频(DS V4 Pro 反馈 #2),voice-ws 侧会切最后 3s + 开头 1s,这里不管切片
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

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

os.environ.setdefault("MODELSCOPE_CACHE", "/home/merkyor/.cache/modelscope")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("emotion_server")

MODEL_ID = os.environ.get("LYNN_SER_MODEL_ID", "iic/emotion2vec_plus_base")
DEVICE = os.environ.get("LYNN_SER_DEVICE", "cuda:0")
MAX_AUDIO_SECONDS = float(os.environ.get("LYNN_SER_MAX_AUDIO_SECONDS", "10"))

_MODEL = None


def _load_model():
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    t0 = time.time()
    log.info(f"loading {MODEL_ID} on {DEVICE} (FunASR AutoModel) ...")
    try:
        from funasr import AutoModel  # type: ignore
    except ImportError as e:
        log.error(f"funasr import failed: {e}. pip install funasr modelscope")
        raise
    _MODEL = AutoModel(
        model=MODEL_ID,
        device=DEVICE,
        disable_update=True,
        disable_log=True,
    )
    elapsed = time.time() - t0
    log.info(f"model loaded in {elapsed:.1f}s")
    return _MODEL


def _duration_ms(wav_bytes: bytes) -> Optional[int]:
    try:
        import soundfile as sf  # type: ignore
        with BytesIO(wav_bytes) as bio:
            info = sf.info(bio)
            return int(info.duration * 1000)
    except Exception:
        return None


def _infer(audio_path: str) -> dict:
    model = _load_model()
    result = model.generate(
        audio_path,
        granularity="utterance",  # 整段 one-shot
        extract_embedding=False,
    )
    # funasr 返回 [{labels: [...], scores: [...], ...}, ...]
    if not result:
        return {"labels": [], "scores": [], "top1": "<unk>", "top1_score": 0.0}
    first = result[0]
    labels = list(first.get("labels") or [])
    scores = [float(s) for s in (first.get("scores") or [])]
    top1_idx = 0
    if scores:
        top1_idx = max(range(len(scores)), key=lambda i: scores[i])
    top1 = labels[top1_idx] if top1_idx < len(labels) else "<unk>"
    top1_score = scores[top1_idx] if top1_idx < len(scores) else 0.0
    return {
        "labels": labels,
        "scores": scores,
        "top1": top1,
        "top1_score": top1_score,
    }


# ---------- FastAPI ----------

@asynccontextmanager
async def lifespan(app: FastAPI):
    _load_model()
    # 预热:跑一次 dummy 避免首请求 P99 514ms spike(session_0430 踩坑 #6)
    try:
        dummy_paths = [
            os.environ.get("LYNN_SER_WARMUP_WAV"),
            str(Path.home() / ".cache/modelscope/hub/models/iic/emotion2vec_plus_base/example/test.wav"),
        ]
        for dp in dummy_paths:
            if dp and Path(dp).exists():
                _infer(dp)
                log.info(f"warmup classify OK (using {dp})")
                break
        else:
            log.warning("no warmup wav found, first request may spike > 500ms")
    except Exception as e:
        log.warning(f"warmup failed (non-fatal): {e}")
    yield


app = FastAPI(title="Lynn emotion2vec+", version="0.79.0", lifespan=lifespan)


@app.get("/health")
async def health():
    loaded = _MODEL is not None
    vram_mb = 0.0
    try:
        import torch  # type: ignore
        if loaded and torch.cuda.is_available():
            vram_mb = torch.cuda.memory_allocated() / 1024 / 1024
    except Exception:
        pass
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


@app.post("/classify")
async def classify(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(status_code=400, detail="missing file")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty audio")

    dur_ms = _duration_ms(raw)
    if dur_ms is not None and dur_ms > MAX_AUDIO_SECONDS * 1000:
        # SER 超过 10s 没意义(DS 反馈 #2 只跑 4s),拒
        raise HTTPException(
            status_code=413,
            detail=f"audio too long for SER: {dur_ms}ms > {int(MAX_AUDIO_SECONDS * 1000)}ms",
        )

    suffix = Path(file.filename).suffix or ".wav"
    with NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(raw)
        tmp_path = tmp.name

    t0 = time.time()
    try:
        result = _infer(tmp_path)
    except Exception as e:
        log.exception("classify failed")
        raise HTTPException(status_code=500, detail=f"classify failed: {e}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    elapsed_ms = int((time.time() - t0) * 1000)
    result["latency_ms"] = elapsed_ms
    result["duration_ms"] = dur_ms
    return JSONResponse(result)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=18008, workers=1)
