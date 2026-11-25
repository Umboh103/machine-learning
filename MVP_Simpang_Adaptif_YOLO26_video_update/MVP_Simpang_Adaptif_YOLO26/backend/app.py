"""Local YOLO26/ByteTrack bridge and durable session journal.
Inference sees pixels only; simulator truth is never substituted for detections.
"""
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import re
import sqlite3
import threading
import sys
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import Response, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .storage import SessionStore, encode
from .edge_bridge import make_edge_router
from .model_profile import load_model_profile

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get("SIMPANG_DATA_DIR", ROOT / "data"))
os.environ.setdefault("YOLO_CONFIG_DIR", str(DATA / "ultralytics"))
os.environ.setdefault("YOLO_AUTOINSTALL", "false")
app = FastAPI(title="Simpang Adaptif recorded CCTV and simulator", version="0.3.1")
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])
store = SessionStore(DATA / "sessions.sqlite3")
model = None
model_lock = threading.Lock()
selected_checkpoint, detector_profile = load_model_profile(ROOT)
weights = str(selected_checkpoint)
weights_hash = None
tracker_sets = {}
frame_clocks = {}
latest_performance = {}
session_settings = {}


@app.exception_handler(sqlite3.Error)
async def journal_error_handler(request, exc):
    return JSONResponse(status_code=507, content={"detail": "MANDATORY_LOG_FAILURE: Penyimpanan sesi gagal; sesi harus dihentikan"})


class SessionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str | None = None
    config: dict = Field(default_factory=dict)
    source: str = "video"
    source_name: str | None = None
    source_id: str | None = None
    source_sha256: str | None = None
    mode: str = "adaptive"
    metadata: dict = Field(default_factory=dict)


class EventInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    client_event_id: str | None = None
    type: str
    time: float = Field(default=0, ge=0)
    media_time: float | None = Field(default=None, ge=0)
    data: dict = Field(default_factory=dict)


class EventBatch(BaseModel):
    events: list[EventInput] = Field(min_length=1, max_length=500)


class EndInput(BaseModel):
    model_config = ConfigDict(extra="allow", allow_inf_nan=False)
    status: str = "ended"
    time: float = Field(default=0, ge=0)
    reason: str = "user"


class ProfileInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    name: str = Field(min_length=1, max_length=80)
    config: dict
    source_width: int = Field(ge=16, le=16384)
    source_height: int = Field(ge=16, le=16384)


def profile_payload(body):
    payload = body.model_dump()
    payload["name"] = body.name.strip()
    if not payload["name"]:
        raise HTTPException(422, "Nama profil wajib diisi")
    inference_settings(body.config)
    for key, minimum, exact in (("rois", 3, None), ("exitLines", 2, 2)):
        polygons = body.config.get(key)
        if not isinstance(polygons, list) or len(polygons) != 4:
            raise HTTPException(422, "Profil memerlukan empat ROI dan garis keluar")
        for polygon in polygons:
            if not isinstance(polygon, list) or len(polygon) < minimum or exact and len(polygon) != exact:
                raise HTTPException(422, "Geometri profil tidak valid")
            if any(not isinstance(point, list) or len(point) != 2 or
                   any(type(x) not in (int, float) or not math.isfinite(x) or not 0 <= x <= 1 for x in point) for point in polygon):
                raise HTTPException(422, "Koordinat profil harus ternormalisasi 0–1")
    try:
        encode(payload)
    except (TypeError, ValueError) as exc:
        raise HTTPException(422, "Profil harus berupa JSON finite") from exc
    return payload


@app.get('/api/profiles')
def list_profiles():
    return {"profiles": store.profiles()}


@app.get('/api/profiles/{profile_id}')
def get_profile(profile_id: str):
    profile = store.profile(profile_id)
    if profile is None:
        raise HTTPException(404, "Profil kamera tidak ditemukan")
    return profile


@app.post('/api/profiles', status_code=201)
def create_profile(body: ProfileInput):
    profile_id, payload = str(uuid.uuid4()), profile_payload(body)
    try:
        store.save_profile(profile_id, payload)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(409, "Nama profil sudah dipakai; pilih nama lain atau muat profil untuk memperbaruinya") from exc
    return store.profile(profile_id)


@app.put('/api/profiles/{profile_id}')
def update_profile(profile_id: str, body: ProfileInput):
    try:
        saved = store.save_profile(profile_id, profile_payload(body), update=True)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(409, "Nama profil sudah dipakai") from exc
    if not saved:
        raise HTTPException(404, "Profil kamera tidak ditemukan")
    return store.profile(profile_id)


def require_session(session_id, active=False):
    row = store.exists(session_id)
    if not row:
        raise HTTPException(404, "Sesi tidak ditemukan")
    if active and row[0] not in ("running", "paused"):
        raise HTTPException(409, "Sesi sudah berakhir")
    return row[0]


def persist(session_id, events):
    try:
        if len(encode(events).encode("utf-8")) > 8 * 1024 * 1024:
            raise HTTPException(413, "Batch log melebihi 8 MiB")
        store.append(session_id, events)
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, "Log harus berupa JSON dengan angka finite") from exc
    except sqlite3.Error as exc:
        raise HTTPException(507, "MANDATORY_LOG_FAILURE: Penyimpanan sesi gagal; sesi harus dihentikan") from exc


def inference_settings(config):
    classes = config.get("vehicleClasses", detector_profile['vehicleClasses'])
    confidence = config.get("confidence", detector_profile['confidence'])
    imgsz = config.get("imgsz", detector_profile['imgsz'])
    if (not isinstance(classes, list) or not classes or len(classes) > 100 or
            any(type(value) is not int or not 0 <= value <= 9999 for value in classes) or len(set(classes)) != len(classes)):
        raise HTTPException(422, "vehicleClasses harus daftar class ID unik nonnegatif")
    if type(confidence) not in (int, float) or not math.isfinite(confidence) or not 0 < confidence <= 1:
        raise HTTPException(422, "confidence harus >0 dan <=1")
    sizes = [imgsz] if type(imgsz) is int else imgsz
    if (not isinstance(sizes, list) or len(sizes) not in (1, 2) or
            any(type(value) is not int or value < 32 or value > 2560 or value % 32 for value in sizes)):
        raise HTTPException(422, "imgsz harus kelipatan 32 (32..2560), satu angka atau [tinggi,lebar]")
    return {"classes": classes, "confidence": confidence, "imgsz": imgsz}


def environment_metadata():
    versions = {}
    for name in ("ultralytics", "torch", "torchvision", "opencv-python", "numpy", "lap", "fastapi", "uvicorn", "onnx", "onnxruntime"):
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
    return {"python": sys.version, "platform": platform.platform(), "processor": platform.processor(), "packages": versions}


def initial_model_metadata(settings):
    checkpoint = Path(weights)
    metadata = {"weights": checkpoint.name, "weights_sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest() if checkpoint.is_file() else None,
                "tracker": "bytetrack.yaml", "class_ids": settings["classes"], "confidence": settings["confidence"], "imgsz": settings["imgsz"],
                "measurement": "bottom-center ROI; timestamp media; waiting only during observed stationary intervals"}
    try:
        tracker_config = importlib.metadata.distribution("ultralytics").locate_file("ultralytics/cfg/trackers/bytetrack.yaml")
        metadata["tracker_config_yaml"] = tracker_config.read_text(encoding="utf-8")
    except (OSError, importlib.metadata.PackageNotFoundError):
        metadata["tracker_config_yaml"] = None
    return metadata


def runtime_device():
    device = getattr(model, "device", None)
    if device is None:
        device = getattr(getattr(model, "predictor", None), "device", None)
    return str(device) if device is not None else "not-loaded"


def runtime_image_size(requested):
    predictor = getattr(model, "predictor", None)
    runtime = getattr(predictor, "model", None)
    session = getattr(runtime, "session", None)
    if session is not None:
        shape = session.get_inputs()[0].shape
        if len(shape) == 4 and all(type(value) is int and value > 0 for value in shape[-2:]):
            return list(shape[-2:])
    size = getattr(predictor, "imgsz", requested)
    return list(size) if isinstance(size, (list, tuple)) else size


@app.get("/api/health")
def health():
    return {"local_backend": True, "model_loaded": model is not None, "weights": Path(weights).name,
            "weights_available": Path(weights).is_file(), "journal": "sqlite-WAL-synchronous-FULL",
            "model_device": runtime_device(), "latest_performance": latest_performance,
            "coordinate_system": "normalized-to-decoded-frame", "version": app.version,
            "detector_profile": detector_profile}


@app.post("/api/sessions", status_code=201)
def create_session(body: SessionInput):
    session_id = body.session_id or str(uuid.uuid4())
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", session_id):
        raise HTTPException(422, "Session ID tidak valid")
    settings = inference_settings(body.config)
    payload = body.model_dump(exclude={"session_id"})
    try:
        payload.update({"source_id": body.source_id or body.source_sha256 or body.source_name or body.source,
                        "config_sha256": hashlib.sha256(json.dumps(body.config, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")).hexdigest(),
                        "environment": environment_metadata(), "model_initial": initial_model_metadata(settings)})
        store.create(session_id, payload)
        session_settings[session_id] = settings
    except sqlite3.IntegrityError as exc:
        raise HTTPException(409, "Session ID sudah dipakai") from exc
    except ValueError as exc:
        raise HTTPException(422, "Konfigurasi harus JSON finite") from exc
    return {"session_id": session_id, "status": "running", "durable": True}


@app.get("/api/sessions")
def sessions():
    return {"sessions": store.list()}


@app.post("/api/sessions/{session_id}/events")
def append_events(session_id: str, body: EventBatch):
    require_session(session_id, active=True)
    persist(session_id, [event.model_dump(exclude_none=True) for event in body.events])
    return {"saved": len(body.events), "durable": True}


@app.post("/api/sessions/{session_id}/end")
def end_session(session_id: str, body: EndInput):
    require_session(session_id)
    with model_lock:
        previous = require_session(session_id)
        if previous not in ("running", "paused"):
            return {"session_id": session_id, "status": previous, "durable": True}
        persist(session_id, [{"type": "lifecycle", "time": body.time, "data": body.model_dump()}])
        store.end(session_id, body.model_dump())
        tracker_sets.pop(session_id, None)
        frame_clocks.pop(session_id, None)
        session_settings.pop(session_id, None)
    return {"session_id": session_id, "status": body.status, "durable": True}


@app.get("/api/sessions/{session_id}/export")
def export_session(session_id: str, format: str = "json"):
    require_session(session_id)
    if format not in ("json", "csv"):
        raise HTTPException(422, "Format harus json atau csv")
    payload = encode(store.export(session_id)) if format == "json" else store.csv(session_id)
    return Response(payload, media_type="application/json" if format == "json" else "text/csv",
                    headers={"Content-Disposition": f'attachment; filename="sesi-{session_id}.{format}"'})


@app.post("/api/reset")
def reset(session_id: str = "legacy"):
    if session_id != "legacy":
        require_session(session_id, active=True)
    with model_lock:
        tracker_sets.pop(session_id, None)
        frame_clocks.pop(session_id, None)
        if model is not None and model.predictor is not None:
            model.predictor.trackers = []
    return {"reset": True, "session_id": session_id}


@app.post("/api/warmup")
def warmup(session_id: str):
    require_session(session_id, active=True)
    import numpy as np
    started = time.perf_counter()
    with model_lock:
        require_session(session_id, active=True)
        if session_id in frame_clocks:
            raise HTTPException(409, "Pemanasan hanya boleh sebelum frame pertama sesi")
        try:
            _, metadata = infer(np.zeros((720, 1280, 3), dtype=np.uint8), session_id)
            tracker_sets.pop(session_id, None)
            if model is not None and model.predictor is not None:
                model.predictor.trackers = []
            result = {"ready": True, "session_id": session_id, "startup_ms": (time.perf_counter() - started) * 1000,
                      "metadata": metadata, "scope": "Model preparation on blank pixels; not a source observation"}
            persist(session_id, [{"type": "model_ready", "time": 0, "data": result}])
            return result
        except HTTPException:
            raise
        except Exception as exc:
            detail = f"Persiapan model gagal: {type(exc).__name__}: {exc}"
            persist(session_id, [{"type": "fault", "time": 0, "data": {"kind": "model-preparation", "detail": detail}}])
            raise HTTPException(503, detail) from exc


def infer(image, session_id):
    """Called under model_lock; transport tests use an explicit fixture substitute."""
    global model, weights_hash
    from ultralytics import YOLO
    settings = session_settings.get(session_id)
    if settings is None:
        settings = inference_settings(store.configuration(session_id))
        session_settings[session_id] = settings
    if model is None:
        Path(weights).parent.mkdir(parents=True, exist_ok=True)
        model = YOLO(weights)
        checkpoint = Path(getattr(model, "ckpt_path", weights))
        weights_hash = hashlib.sha256(checkpoint.read_bytes()).hexdigest() if checkpoint.is_file() else None
    if model.predictor is not None:
        model.predictor.trackers = tracker_sets.get(session_id, [])
    started = time.perf_counter()
    result = model.track(image, persist=True, tracker="bytetrack.yaml", classes=settings["classes"],
                         conf=settings["confidence"], imgsz=settings["imgsz"], verbose=False)[0]
    tracker_sets[session_id] = model.predictor.trackers
    detections = []
    if result.boxes is not None and result.boxes.id is not None:
        height, width = image.shape[:2]
        for box, ident, cls, conf in zip(result.boxes.xyxy.cpu().tolist(), result.boxes.id.cpu().tolist(),
                                         result.boxes.cls.cpu().tolist(), result.boxes.conf.cpu().tolist()):
            x1, y1, x2, y2 = box
            detections.append({"id": int(ident), "class_id": int(cls), "label": result.names[int(cls)],
                               "confidence": conf, "box": [max(0., min(1., x1 / width)), max(0., min(1., y1 / height)),
                                                          max(0., min(1., x2 / width)), max(0., min(1., y2 / height))]})
    tracker = model.predictor.trackers[0]
    metadata = {"ultralytics": importlib.metadata.version("ultralytics"), "weights": Path(weights).name,
                "weights_sha256": weights_hash, "tracker": "bytetrack.yaml", "tracker_config": vars(tracker.args),
                "class_ids": settings["classes"], "confidence": settings["confidence"],
                "imgsz_requested": settings["imgsz"], "imgsz": runtime_image_size(settings["imgsz"]),
                "device": runtime_device(), "inference_ms": (time.perf_counter() - started) * 1000}
    metadata["tracker_config"] = json.loads(json.dumps(metadata["tracker_config"], default=str))
    return detections, metadata


@app.post("/api/track")
def track(frame: UploadFile = File(...), session_id: str = Form("legacy"),
          media_time: float | None = Form(None), frame_id: int | None = Form(None),
          original_width: int | None = Form(None), original_height: int | None = Form(None)):
    received = time.perf_counter()
    if session_id != "legacy":
        require_session(session_id, active=True)
        if media_time is None or frame_id is None:
            raise HTTPException(422, "media_time dan frame_id wajib untuk sesi")
    if media_time is not None and (not math.isfinite(media_time) or media_time < 0):
        raise HTTPException(422, "Timestamp media harus finite dan nonnegatif")
    if frame_id is not None and frame_id < 0:
        raise HTTPException(422, "frame_id harus nonnegatif")
    raw = frame.file.read(12 * 1024 * 1024 + 1)
    if len(raw) > 12 * 1024 * 1024:
        raise HTTPException(413, "Frame melebihi 12 MiB")
    try:
        import cv2
        import numpy as np
    except ImportError as exc:
        raise HTTPException(503, "Dependensi inferensi belum tersedia; instal requirements.txt") from exc
    image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR) if raw else None
    if image is None:
        raise HTTPException(400, "Frame gambar tidak valid")
    native_height, native_width = image.shape[:2]
    scale = min(1., 1280 / native_width, 720 / native_height)
    if scale < 1:
        image = cv2.resize(image, (max(1, round(native_width * scale)), max(1, round(native_height * scale))), interpolation=cv2.INTER_AREA)
    with model_lock:
        if session_id != "legacy":
            require_session(session_id, active=True)
        previous_time, previous_id = frame_clocks.get(session_id, (-1., -1))
        if (media_time is not None and media_time <= previous_time) or (frame_id is not None and frame_id <= previous_id):
            raise HTTPException(409, "Frame duplikat atau timestamp media mundur; mulai sesi baru untuk seek")
        started = time.perf_counter()
        try:
            detections, metadata = infer(image, session_id)
            for detection in detections:
                detection.update({"media_time": media_time, "frame_id": frame_id})
            elapsed = (time.perf_counter() - received) * 1000
            metadata.update({"frame_width": image.shape[1], "frame_height": image.shape[0],
                             "decoded_width": native_width, "decoded_height": native_height,
                             "original_width": original_width or native_width, "original_height": original_height or native_height,
                             "coordinates": "normalized-to-decoded-frame", "processing_ms": elapsed,
                             "lock_wait_ms": (started - received) * 1000})
            response = {"valid": True, "session_id": session_id, "media_time": media_time,
                        "frame_id": frame_id, "detections": detections, "metadata": metadata}
            if session_id != "legacy":
                persist(session_id, [{"type": "observation", "time": media_time, "media_time": media_time, "data": response}])
            frame_clocks[session_id] = (media_time if media_time is not None else previous_time,
                                        frame_id if frame_id is not None else previous_id)
            latest_performance.clear()
            latest_performance.update({"processing_ms": elapsed, "device": metadata.get("device"),
                                       "inference_ms": metadata.get("inference_ms"), "frame_width": image.shape[1], "frame_height": image.shape[0]})
            return response
        except HTTPException:
            raise
        except Exception as exc:
            detail = f"Inferensi YOLO26 gagal: {type(exc).__name__}: {exc}"
            if session_id != "legacy":
                persist(session_id, [{"type": "fault", "time": media_time or 0, "data": {"kind": "inference", "detail": detail}}])
            raise HTTPException(503, detail) from exc


app.include_router(make_edge_router(store))
app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="dashboard")
