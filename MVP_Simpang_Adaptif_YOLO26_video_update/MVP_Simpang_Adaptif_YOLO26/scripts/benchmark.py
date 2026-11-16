"""Actual model backend benchmark; blank synthetic frames are never accuracy evidence."""
import argparse
import hashlib
import importlib
import json
import platform
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", type=Path, help="Optional real local recording; default is synthetic empty-road pixels")
    parser.add_argument("--frames", type=int, default=30)
    parser.add_argument("--warmup", type=int, default=3)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--imgsz", type=int, help="Optional model inference side (multiple32); decoded input remains1280x720")
    parser.add_argument("--output", type=Path, default=ROOT / "validation" / "backend-benchmark.json")
    args = parser.parse_args()
    import cv2
    import numpy as np
    import torch
    from fastapi.testclient import TestClient
    torch.set_num_threads(max(1, args.threads))
    backend = importlib.import_module("backend.app")
    client = TestClient(backend.app)
    ident = "benchmark-" + str(uuid.uuid4())
    source = str(args.video) if args.video else "synthetic-empty-1280x720"
    config = {"imgsz": args.imgsz} if args.imgsz else {}
    client.post("/api/sessions", json={"session_id": ident, "config": config, "source": "benchmark", "source_name": source,
                                     "metadata": {"scope": "real YOLO26+ByteTrack inference, backend in-process transport"}}).raise_for_status()
    capture = cv2.VideoCapture(str(args.video)) if args.video else None
    fps = capture.get(cv2.CAP_PROP_FPS) if capture else 30
    if capture and not capture.isOpened():
        raise RuntimeError("Cannot read supplied video")
    durations, backend_ms, detections = [], [], []
    report = {"created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "session_id": ident,
              "source": source, "synthetic": not bool(args.video), "resolution": [1280, 720],
              "platform": platform.platform(), "processor": platform.processor(), "python": sys.version,
              "torch": torch.__version__, "cuda_available": torch.cuda.is_available(), "torch_threads": torch.get_num_threads(),
              "inference_imgsz": args.imgsz or [736, 1280],
              "scope": "JPEG encode + multipart TestClient transport + real model/ByteTrack + durable raw observation; excludes browser, Observer snapshot and network",
              "acceptance": "Not AT acceptance; requires representative annotated video and browser frame-to-snapshot benchmark"}
    latest = None
    try:
        for index in range(args.frames + args.warmup):
            if capture:
                ok, image = capture.read()
                if not ok:
                    break
                h, w = image.shape[:2]
                scale = min(1280 / w, 720 / h)
                image = cv2.resize(image, (round(w * scale), round(h * scale)))
                media_time = index / (fps or 30)
            else:
                image = np.full((720, 1280, 3), 65, dtype=np.uint8)
                cv2.line(image, (640, 0), (640, 720), (190, 190, 190), 3)
                media_time = index / 30
            started = time.perf_counter()
            encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()
            response = client.post("/api/track", files={"frame": ("frame.jpg", encoded, "image/jpeg")},
                                   data={"session_id": ident, "frame_id": str(index + 1), "media_time": str(media_time)})
            response.raise_for_status()
            latest = response.json()
            duration = (time.perf_counter() - started) * 1000
            if index >= args.warmup:
                durations.append(duration)
                backend_ms.append(latest["metadata"]["processing_ms"])
                detections.append(len(latest["detections"]))
        if not durations:
            raise RuntimeError("No measured frames; recording shorter than warmup")
        ordered = sorted(durations)
        p95 = ordered[max(0, int(np.ceil(len(ordered) * .95)) - 1)]
        effective_fps = 1000 * len(durations) / sum(durations)
        report.update({"status": "measured", "warmup_frames": args.warmup, "measured_frames": len(durations),
                       "effective_fps": effective_fps, "p95_frame_to_raw_observation_ms": p95,
                       "mean_frame_to_raw_observation_ms": sum(durations) / len(durations),
                       "frame_durations_ms": durations, "backend_processing_ms": backend_ms, "detections_per_frame": detections,
                       "metadata": latest["metadata"], "performance_targets_on_this_input": {"fps_gte_10": effective_fps >= 10, "raw_observation_p95_lte_1000ms": p95 <= 1000}})
    except Exception as exc:
        report.update({"status": "blocked", "reason": f"{type(exc).__name__}: {exc}"})
    finally:
        if capture:
            capture.release()
        client.post(f"/api/sessions/{ident}/end", json={"reason": "benchmark", "status": "ended"})
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        print(json.dumps({k: v for k, v in report.items() if k not in ("frame_durations_ms", "backend_processing_ms", "metadata")}, ensure_ascii=True))
    return 0 if report["status"] == "measured" else 1


if __name__ == "__main__":
    raise SystemExit(main())
