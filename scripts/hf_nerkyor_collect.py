#!/usr/bin/env python3
"""Collect HF nerkyor public model stats.

Lynn 0511: 由 GitHub Actions 每天 08:30 北京时间运行,因为腾讯云 brain server
不通 HF API(出口墙),需要 GitHub Actions runner(Azure US)做代理拉数据,
落到 data/hf_nerkyor.json 后 brain server 通过 GitHub Contents API 拉文件。

Output JSON schema:
{
  "collected_at": ISO timestamp,
  "author": "nerkyor",
  "models": [
    {"id": "nerkyor/foo", "name": "foo", "downloads_30d": N, "likes": N, "last_modified": "YYYY-MM-DD"},
    ...
  ],
  "total_models": N,
  "total_downloads_30d": N
}
"""
import argparse
import datetime
import json
import os
import sys
import urllib.request

HF_AUTHOR = "nerkyor"
HF_API = f"https://huggingface.co/api/models?author={HF_AUTHOR}&limit=50&full=true"


def fetch_hf_models():
    req = urllib.request.Request(HF_API, headers={"User-Agent": "lynn-stats/1.0"})
    r = urllib.request.urlopen(req, timeout=30)
    return json.loads(r.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", required=True, help="Output JSON path")
    args = ap.parse_args()

    try:
        data = fetch_hf_models()
    except Exception as e:
        print(f"[FATAL] HF API fail: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)

    models = []
    total_dl = 0
    for m in data:
        mid = m.get("id", "")
        if not mid.startswith(f"{HF_AUTHOR}/"):
            continue
        dl = m.get("downloads", 0) or 0
        likes = m.get("likes", 0) or 0
        last_mod = (m.get("lastModified") or "")[:10]
        models.append({
            "id": mid,
            "name": mid.split("/", 1)[1] if "/" in mid else mid,
            "downloads_30d": dl,
            "likes": likes,
            "last_modified": last_mod,
        })
        total_dl += dl

    models.sort(key=lambda x: -x["downloads_30d"])

    out = {
        "collected_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "author": HF_AUTHOR,
        "models": models,
        "total_models": len(models),
        "total_downloads_30d": total_dl,
    }

    parent = os.path.dirname(args.output)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    print(f"[OK] wrote {len(models)} models, total_downloads_30d={total_dl} → {args.output}")


if __name__ == "__main__":
    main()
