"""Transport/journal tests use explicit inference fixtures, never acceptance evidence."""
import csv
import importlib
import io
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

import cv2
import numpy as np
from fastapi.testclient import TestClient

backend = importlib.import_module("backend.app")
from backend.storage import SessionStore


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_store = backend.store
        backend.store = SessionStore(Path(self.tmp.name) / "sessions.sqlite3")
        backend.frame_clocks.clear()
        backend.tracker_sets.clear()
        backend.session_settings.clear()
        self.client = TestClient(backend.app)
        self.create("test-session")

    def tearDown(self):
        self.client.close()
        backend.tracker_sets.clear()
        backend.frame_clocks.clear()
        backend.session_settings.clear()
        backend.store = self.old_store
        self.tmp.cleanup()

    def create(self, name):
        response = self.client.post("/api/sessions", json={"session_id": name, "config": {"fixed": 30}, "source": "video"})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["session_id"], name)

    def image(self, shape=(720, 1280, 3)):
        return cv2.imencode(".jpg", np.zeros(shape, dtype=np.uint8))[1].tobytes()

    def track(self, media_time=0, frame_id=1, name="test-session", image=None):
        return self.client.post("/api/track", files={"frame": ("frame.jpg", image or self.image(), "image/jpeg")},
                                data={"session_id": name, "media_time": str(media_time), "frame_id": str(frame_id)})

    def test_dashboard_health_and_host_restriction(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertIn("local_backend", self.client.get("/api/health").json())
        self.assertEqual(self.client.get("/api/health", headers={"host": "evil.example"}).status_code, 400)

    def test_active_model_profile_is_shared_with_dashboard_and_session_defaults(self):
        profile = self.client.get('/api/health').json()['detector_profile']
        settings = backend.inference_settings({})
        self.assertEqual(settings['classes'], profile['vehicleClasses'])
        self.assertEqual(settings['imgsz'], profile['imgsz'])
        self.assertEqual(settings['confidence'], profile['confidence'])
        exported = self.client.get('/api/sessions/test-session/export').json()
        self.assertEqual(exported['model_initial']['class_ids'], profile['vehicleClasses'])
        self.assertEqual(exported['model_initial']['weights'], profile['weights'])

    def test_fixed_onnx_input_size_is_distinct_from_requested_inference_size(self):
        session=SimpleNamespace(get_inputs=lambda:[SimpleNamespace(shape=[1,3,384,640])])
        runtime=SimpleNamespace(predictor=SimpleNamespace(model=SimpleNamespace(session=session),imgsz=[736,1280]))
        with patch.object(backend,'model',runtime):
            self.assertEqual(backend.runtime_image_size([736,1280]),[384,640])
        with patch.object(backend,'model',SimpleNamespace(predictor=SimpleNamespace(model=None,imgsz=[736,1280]))):
            self.assertEqual(backend.runtime_image_size([736,1280]),[736,1280])

    def test_empty_frame_is_valid_observation_and_is_durable(self):
        with patch.object(backend, "infer", return_value=([], {"inference_ms": 12, "device": "fixture"})):
            result = self.track().json()
        self.assertTrue(result["valid"])
        self.assertEqual(result["detections"], [])
        self.assertEqual(result["media_time"], 0)
        self.assertEqual(result["frame_id"], 1)
        self.assertEqual(result["metadata"]["frame_width"], 1280)
        restored = SessionStore(backend.store.path).export("test-session")
        self.assertEqual(restored["events"][-1]["type"], "observation")

    def test_resize_preserves_aspect_ratio_and_normalized_coordinates(self):
        seen = []
        def fixture(image, session):
            seen.append(image.shape[:2])
            return [{"id": 7, "class_id": 2, "box": [.1, .2, .3, .4], "confidence": .9, "label": "car"}], {}
        with patch.object(backend, "infer", side_effect=fixture):
            result = self.track(image=self.image((1080, 1920, 3))).json()
        self.assertEqual(seen, [(720, 1280)])
        self.assertEqual(result["detections"][0]["box"], [.1, .2, .3, .4])
        self.assertEqual(result["metadata"]["decoded_width"], 1920)

    def test_monotonic_clocks_and_independent_sessions(self):
        self.create("second-session")
        with patch.object(backend, "infer", return_value=([], {})):
            self.assertEqual(self.track(2, 2).status_code, 200)
            self.assertEqual(self.track(2, 3).status_code, 409)
            self.assertEqual(self.track(1, 3).status_code, 409)
            self.assertEqual(self.track(3, 2).status_code, 409)
            self.assertEqual(self.track(0, 1, "second-session").status_code, 200)
            self.client.post("/api/reset?session_id=test-session")
            self.assertEqual(self.track(0, 1).status_code, 200)

    def test_model_preparation_is_logged_without_consuming_a_media_frame(self):
        with patch.object(backend, "infer", return_value=([], {"device": "fixture"})):
            prepared = self.client.post('/api/warmup?session_id=test-session')
            self.assertEqual(prepared.status_code, 200)
            self.assertTrue(prepared.json()['ready'])
            self.assertNotIn('test-session', backend.frame_clocks)
            events = backend.store.export('test-session')['events']
            self.assertEqual(events[-1]['type'], 'model_ready')
            self.assertFalse(any(e['type'] == 'observation' for e in events))
            self.assertEqual(self.track(0, 1).status_code, 200)
            self.assertEqual(self.client.post('/api/warmup?session_id=test-session').status_code, 409)

    def test_model_preparation_failure_is_not_acknowledged_as_ready(self):
        with patch.object(backend, "infer", side_effect=RuntimeError('fixture warmup failure')):
            result = self.client.post('/api/warmup?session_id=test-session')
        self.assertEqual(result.status_code, 503)
        self.assertEqual(backend.store.export('test-session')['events'][-1]['data']['kind'], 'model-preparation')

    def test_failure_is_logged_and_never_empty_success(self):
        with patch.object(backend, "infer", side_effect=RuntimeError("fixture error")):
            result = self.track()
        self.assertEqual(result.status_code, 503)
        self.assertEqual(backend.store.export("test-session")["events"][-1]["type"], "fault")
        self.assertNotIn("test-session", backend.frame_clocks)

    def test_mandatory_journal_failure_never_acknowledges_a_frame_or_event(self):
        with patch.object(backend.store, "append", side_effect=sqlite3.OperationalError("disk full")), patch.object(backend, "infer", return_value=([], {})):
            result = self.track()
            self.assertEqual(result.status_code, 507)
            self.assertIn("MANDATORY_LOG_FAILURE", result.json()["detail"])
            result = self.client.post("/api/sessions/test-session/events", json={"events": [{"type": "snapshot"}]})
            self.assertEqual(result.status_code, 507)
        self.assertNotIn("test-session", backend.frame_clocks)

    def test_events_deduplicate_retry_and_exports_survive_store_reopen(self):
        batch = {"events": [
            {"client_event_id": "id-1", "type": "snapshot", "time": 1, "media_time": .9,
             "data": {"valid": True, "rows": [{"q": 0, "w": 0, "avg": 0}, {"q": 2, "w": 3, "avg": 2, "estimated": True}]}},
            {"client_event_id": "id-2", "type": "decision", "time": 30, "data": {"green": 28}},
            {"client_event_id": "id-3", "type": "transition", "time": 33, "data": {"state": "KUNING"}},
            {"client_event_id": "id-4", "type": "fault", "time": 40, "data": {"kind": "stale"}},
        ]}
        self.assertEqual(self.client.post("/api/sessions/test-session/events", json=batch).status_code, 200)
        self.client.post("/api/sessions/test-session/events", json=batch)
        backend.store = SessionStore(backend.store.path)
        exported = self.client.get("/api/sessions/test-session/export").json()
        self.assertEqual(len(exported["events"]), 5)
        rows = list(csv.DictReader(io.StringIO(self.client.get("/api/sessions/test-session/export?format=csv").text)))
        snapshots = [row for row in rows if row["type"] == "snapshot"]
        self.assertEqual(len(snapshots), 2)
        self.assertEqual(snapshots[0]["queue_vehicles"], "0")
        self.assertEqual(snapshots[1]["estimated"], "True")

    def test_end_rejects_further_frames_and_events(self):
        response = self.client.post("/api/sessions/test-session/end", json={"time": 10, "reason": "eof"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.track(11, 11).status_code, 409)
        self.assertEqual(self.client.post("/api/sessions/test-session/events", json={"events": [{"type": "snapshot"}]}).status_code, 409)
        self.assertEqual(self.client.get("/api/sessions").json()["sessions"][0]["status"], "ended")
        before = len(backend.store.export("test-session")["events"])
        self.client.post("/api/sessions/test-session/end", json={"time": 10, "reason": "eof"})
        self.assertEqual(len(backend.store.export("test-session")["events"]), before)

    def test_inference_configuration_and_export_identity(self):
        for invalid in ({"vehicleClasses": []}, {"vehicleClasses": [2, 2]}, {"vehicleClasses": [-1]},
                        {"confidence": 0}, {"confidence": 1.1}, {"imgsz": 631}, {"imgsz": [32, 0]}):
            self.assertEqual(self.client.post("/api/sessions", json={"config": invalid}).status_code, 422)
        response = self.client.post("/api/sessions", json={"session_id": "custom", "source_name": "custom.mp4", "config": {"vehicleClasses": [5], "confidence": .4, "imgsz": 640}})
        self.assertEqual(response.status_code, 201)
        exported = self.client.get("/api/sessions/custom/export").json()
        self.assertEqual(exported["source_id"], "custom.mp4")
        self.assertEqual(len(exported["config_sha256"]), 64)
        self.assertEqual(exported["model_initial"]["class_ids"], [5])
        self.assertEqual(exported["model_initial"]["confidence"], .4)
        self.assertEqual(exported["model_initial"]["imgsz"], 640)
        self.assertIn("torch", exported["environment"]["packages"])
        self.assertTrue(exported["model_initial"]["tracker_config_yaml"])

    def test_pause_resume_lifecycle_is_persisted(self):
        for status in ("paused", "running"):
            self.client.post("/api/sessions/test-session/events", json={"events": [{"type": "lifecycle", "time": 2, "data": {"status": status}}]})
            self.assertEqual(self.client.get("/api/sessions/test-session/export").json()["status"], status)
        for state, status in (("paused", "paused"), ("resumed", "running")):
            self.client.post("/api/sessions/test-session/events", json={"events": [{"type": "lifecycle", "time": 3, "data": {"state": state}}]})
            self.assertEqual(self.client.get("/api/sessions").json()["sessions"][0]["status"], status)
        self.assertEqual(self.client.get("/api/sessions").json()["sessions"][0]["source"], "video")

    def test_camera_profile_roundtrip_update_and_session_configuration_isolation(self):
        config={"fixed": 30, "rois": [[[.1,.1],[.2,.1],[.2,.2]] for _ in range(4)],
                "exitLines": [[[.1,.2],[.2,.2]] for _ in range(4)]}
        payload={"name": "Kamera Utara", "config": config, "source_width": 1280, "source_height": 720}
        response=self.client.post('/api/profiles', json=payload)
        self.assertEqual(response.status_code,201)
        ident=response.json()['profile_id']
        backend.store=SessionStore(backend.store.path)
        self.assertEqual(self.client.get(f'/api/profiles/{ident}').json()['config'],config)
        self.assertEqual(self.client.get('/api/profiles').json()['profiles'][0]['name'],'Kamera Utara')
        self.assertEqual(self.client.post('/api/profiles',json=payload).status_code,409)
        payload['config']['fixed']=40
        self.assertEqual(self.client.put(f'/api/profiles/{ident}',json=payload).status_code,200)
        self.assertEqual(backend.store.configuration('test-session')['fixed'],30)
        self.assertEqual(self.client.put('/api/profiles/missing',json=payload).status_code,404)

    def test_camera_profile_rejects_invalid_coordinates_dimensions_and_name(self):
        payload={"name":" ","config":{},"source_width":1280,"source_height":720}
        self.assertEqual(self.client.post('/api/profiles',json=payload).status_code,422)
        payload['name']='Camera'
        self.assertEqual(self.client.post('/api/profiles',json=payload).status_code,422)
        payload['source_width']=0
        self.assertEqual(self.client.post('/api/profiles',json=payload).status_code,422)
        payload['source_width']=1280
        payload['config']={"rois":[[[2,.1],[.2,.1],[.2,.2]] for _ in range(4)],"exitLines":[[[.1,.2],[.2,.2]] for _ in range(4)]}
        self.assertEqual(self.client.post('/api/profiles',json=payload).status_code,422)

    def test_invalid_input_missing_session_and_missing_clocks(self):
        self.assertEqual(self.client.get("/api/sessions/missing/export").status_code, 404)
        self.assertEqual(self.client.post("/api/sessions", json={"session_id": "../bad"}).status_code, 422)
        self.assertEqual(self.client.post("/api/track", files={"frame": ("x.jpg", b"bad")}).status_code, 400)
        self.assertEqual(self.client.post("/api/track", files={"frame": ("x.jpg", b"")}).status_code, 400)
        self.assertEqual(self.client.post("/api/track", files={"frame": ("x.jpg", self.image())}, data={"session_id": "test-session"}).status_code, 422)

    @unittest.skipUnless(os.environ.get("SIMPANG_REAL_INFERENCE") == "1", "Set SIMPANG_REAL_INFERENCE=1 for real local YOLO weights")
    def test_real_yolo_bytetrack_sample_persistence_isolation_and_empty(self):
        import torch
        import ultralytics
        torch.set_num_threads(4)
        sample = Path(ultralytics.__file__).parent / "assets" / "bus.jpg"
        raw = sample.read_bytes()
        self.create("real-second")
        prepared = self.client.post('/api/warmup?session_id=test-session')
        self.assertEqual(prepared.status_code, 200)
        self.assertNotIn('test-session', backend.frame_clocks)
        results = [self.track(0, 1, image=raw).json(),
                   self.track(0, 1, "real-second", image=raw).json(),
                   self.track(.1, 2, image=raw).json()]
        for result in results:
            self.assertTrue(result.get("valid"), result)
            self.assertTrue(result["detections"], "Official bus sample must produce at least one tracked vehicle")
            self.assertTrue(all(d["class_id"] in backend.inference_settings({})['classes'] for d in result["detections"]))
            self.assertTrue(all(0 <= coordinate <= 1 for d in result["detections"] for coordinate in d["box"]))
        first_ids = [d["id"] for d in results[0]["detections"]]
        self.assertEqual(first_ids, [d["id"] for d in results[1]["detections"]])
        self.assertEqual(first_ids, [d["id"] for d in results[2]["detections"]])
        empty = self.track(.2, 3).json()
        self.assertTrue(empty["valid"])
        self.assertEqual(empty["detections"], [])
        self.assertEqual(self.client.post("/api/reset?session_id=test-session").status_code, 200)
        reset = self.track(0, 1, image=raw).json()
        self.assertEqual(first_ids, [d["id"] for d in reset["detections"]])
        report = {"scope": "Selected YOLO checkpoint+ByteTrack on Ultralytics packaged bus.jpg; no traffic ground truth or accuracy acceptance",
                  "source": "ultralytics/assets/bus.jpg", "preparation": prepared.json(), "sessions": results, "empty": empty, "reset": reset,
                  "checks": {"tracked_vehicle": True, "stable_id": True, "session_isolation": True, "normalized_coordinates": True, "valid_empty": True, "tracker_reset": True}}
        target = Path(os.environ.get("SIMPANG_REAL_REPORT", backend.ROOT / "validation" / "real-inference-smoke.json"))
        report["weights"] = Path(backend.weights).name
        target.write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
