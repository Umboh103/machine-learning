"""YOLO26/ByteTrack density-to-plan example; stdout, local HTTP or simulator MQTT.

This sends expiring proposals, never electrical lamp states. A separate controller
must own timing, conflicts, clearance, feedback and watchdog fallback. ROI counts
here measure tracked presence; they are not the existing SRS stopped-queue metric.
"""
import argparse
from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import threading
import time
import uuid

import cv2
import numpy as np


# Support direct execution with the existing workspace interpreter.
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from backend.edge_protocol import (validate_config, weighted_presence, proposed_green,
                                   build_proposal, config_digest)


@dataclass(frozen=True)
class Frame:
    sequence: int
    epoch: int
    decoded_mono: float
    media_time: float | None
    image: object


class LatestCapture:
    """One-slot capture thread; inference cannot build an unbounded frame queue."""
    def __init__(self, source, kind):
        self.source, self.kind = source, kind
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.latest = None
        self.eof = False
        self.failed = False
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()
        return self

    def get(self):
        with self.lock:
            return self.latest

    def _run(self):
        sequence = epoch = 0
        while not self.stop.is_set():
            if self.kind == 'stream':
                cap = cv2.VideoCapture(self.source, cv2.CAP_FFMPEG,
                                      [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 3000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 1000])
            else:
                cap = cv2.VideoCapture(self.source)
            if not cap.isOpened():
                cap.release()
                if self.kind != 'stream':
                    self.failed = True
                    return
                self.stop.wait(1)
                continue
            epoch += 1
            fps = cap.get(cv2.CAP_PROP_FPS)
            fps = fps if math.isfinite(fps) and fps > 0 else 25
            opened, index = time.monotonic(), 0
            while not self.stop.is_set():
                ok, image = cap.read()
                if not ok:
                    with self.lock:
                        self.latest = None
                    if self.kind == 'file':
                        self.eof = True
                    break
                media_time = index / fps if self.kind == 'file' else None
                index += 1
                if self.kind == 'file' and self.stop.wait(max(0, opened + media_time - time.monotonic())):
                    break
                sequence += 1
                with self.lock:
                    self.latest = Frame(sequence, epoch, time.monotonic(), media_time, image)
            cap.release()
            if self.kind == 'file':
                return
            self.stop.wait(1)

    def close(self):
        self.stop.set()
        self.thread.join(timeout=4)


class LocalSimulator:
    def __init__(self, base, session, config, source_name, metadata):
        from urllib.parse import urlsplit
        parsed = urlsplit(base)
        if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
            raise ValueError('Simulator URL must be a local http://127.0.0.1:PORT origin')
        self.base = base.rstrip('/')
        self.session = session
        self.post('/api/edge/sessions', {'session_id': session, 'config': config, 'source_name': source_name, 'metadata': metadata})
        print(json.dumps({'simulator_session_id': session, 'open': self.base+'/edge.html'}), flush=True)

    def post(self, path, data):
        from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler
        class NoRedirect(HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                raise RuntimeError('Local simulator redirects are not allowed')
        request = Request(self.base+path, data=json.dumps(data, allow_nan=False).encode(), headers={'Content-Type': 'application/json'}, method='POST')
        with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=2) as response:
            return json.loads(response.read(1024*1024))

    def send(self, proposal):
        return self.post(f'/api/edge/sessions/{self.session}/proposals', proposal)


class Publisher:
    def __init__(self, args, session, config=None, metadata=None):
        self.client = None
        self.bridge = None
        self.topic = f'traffic/sim/{args.intersection}/plan/proposed'
        if getattr(args, 'simulator_url', None):
            if args.broker:
                raise ValueError('Choose one output transport')
            self.bridge = LocalSimulator(args.simulator_url, session, config, Path(args.source).name[:160] if args.kind == 'file' else args.kind, metadata or {})
        if args.broker:
            import paho.mqtt.client as mqtt
            self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f'edge-example-{session[:8]}', protocol=mqtt.MQTTv5)
            self.client.max_inflight_messages_set(1)
            self.client.max_queued_messages_set(1)
            self.client.tls_set(ca_certs=args.ca)
            if os.getenv('MQTT_USERNAME'):
                self.client.username_pw_set(os.environ['MQTT_USERNAME'], os.getenv('MQTT_PASSWORD'))
            self.client.will_set(f'traffic/sim/{args.intersection}/health', json.dumps({'online': False, 'session_id': session}), qos=1, retain=True)
            self.client.connect(args.broker, args.port, keepalive=10)
            self.client.loop_start()

    def send(self, proposal):
        payload = json.dumps(proposal, allow_nan=False)
        if self.bridge:
            self.bridge.send(proposal)
        elif self.client:
            from paho.mqtt.properties import Properties
            from paho.mqtt.packettypes import PacketTypes
            props = Properties(PacketTypes.PUBLISH)
            props.MessageExpiryInterval = max(1, (proposal['valid_until_utc_ms'] - proposal['created_at_utc_ms']) // 1000)
            result = self.client.publish(self.topic, payload, qos=1, retain=False, properties=props)
            result.wait_for_publish(timeout=1)
            if not result.is_published():
                raise RuntimeError('Broker acknowledgement timeout; application acknowledgement is still separate')
        else:
            print(payload, flush=True)

    def close(self):
        if self.client:
            self.client.disconnect()
            self.client.loop_stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path(__file__).with_name('config.example.json'))
    parser.add_argument('--weights', default='weights/yolo26n.pt')
    parser.add_argument('--source', default=os.getenv('TRAFFIC_SOURCE', '0'))
    parser.add_argument('--kind', choices=['file', 'stream', 'usb'], default='usb')
    parser.add_argument('--imgsz', type=int, default=640)
    parser.add_argument('--device', help='cpu or CUDA device such as 0; default uses runtime selection')
    parser.add_argument('--max-frames', type=int, default=0)
    parser.add_argument('--report', type=Path)
    parser.add_argument('--broker', help='Optional TLS broker; only the traffic/sim topic is used')
    parser.add_argument('--simulator-url', help='Local FastAPI origin, e.g. http://127.0.0.1:8000; open /edge.html')
    parser.add_argument('--port', type=int, default=8883)
    parser.add_argument('--ca')
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding='utf-8'))
    classes = list(validate_config(config))
    args.intersection = config['intersection_id']
    if any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in args.intersection):
        parser.error('Use an alphanumeric intersection ID')
    if args.imgsz < 32 or args.imgsz % 32 or args.max_frames < 0:
        parser.error('Invalid inference size or frame limit')
    from ultralytics import YOLO
    import torch
    torch.set_num_threads(4)
    model = YOLO(args.weights)
    # Prepare before opening a short recording. Explicitly select one-to-one.
    model.predict(np.zeros((720, 1280, 3), np.uint8), nms=False, classes=classes, conf=.10, imgsz=args.imgsz, device=args.device, verbose=False)
    if not getattr(model.predictor.model, 'end2end', False):
        raise RuntimeError('This artifact is not NMS-free. Export a compatible checkpoint with nms=False; a loaded graph cannot be changed by a flag.')
    source = int(args.source) if args.kind == 'usb' else args.source
    session = str(uuid.uuid4())
    from importlib.metadata import version
    weights_sha256 = hashlib.sha256(Path(args.weights).read_bytes()).hexdigest() if Path(args.weights).is_file() else None
    metadata = {'model_family': 'YOLO26', 'ultralytics_version': version('ultralytics'), 'nms_free': True,
                'tracker': 'ByteTrack', 'weights_sha256': weights_sha256, 'device': str(model.predictor.model.device),
                'imgsz_requested': args.imgsz, 'measurement_kind': 'unique-tracked-ROI-presence; not stopped queue'}
    publisher = Publisher(args, session, config, metadata)
    capture = LatestCapture(source, args.kind).start()
    seq = processed = last_frame = epoch = 0
    last_publish = 0.
    started, latencies = time.monotonic(), []
    report = {'scope': 'Real inference smoke; ROI presence example, not production controller or accuracy acceptance', 'session_id': session, **metadata}
    try:
        while True:
            frame = capture.get()
            if capture.failed or capture.eof:
                seq += 1
                publisher.send(build_proposal(config, session, seq, None, math.inf, reason='end-of-file' if capture.eof else 'source-unavailable', source_epoch=epoch))
                break
            if frame is None or frame.sequence == last_frame:
                if time.monotonic() - last_publish >= 1 and (frame is None or time.monotonic() - frame.decoded_mono > config['snapshot_max_age_s']):
                    seq += 1
                    publisher.send(build_proposal(config, session, seq, None, math.inf, reason='no-new-frame', source_epoch=epoch))
                    last_publish = time.monotonic()
                time.sleep(.01)
                continue
            last_frame = frame.sequence
            if frame.epoch != epoch:
                for tracker in getattr(model.predictor, 'trackers', []):
                    tracker.reset()
                epoch = frame.epoch
            result = model.track(frame.image, persist=True, tracker='bytetrack.yaml', classes=classes, conf=.10, imgsz=args.imgsz, device=args.device, nms=False, verbose=False)[0]
            boxes, detections, reason = result.boxes, [], None
            if boxes is not None and len(boxes) and boxes.id is None:
                reason = 'tracker-not-ready'
            elif boxes is not None and boxes.id is not None:
                height, width = frame.image.shape[:2]
                for ident, cls, conf, xyxy in zip(boxes.id.cpu().tolist(), boxes.cls.cpu().tolist(), boxes.conf.cpu().tolist(), boxes.xyxy.cpu().tolist()):
                    x1, y1, x2, y2 = xyxy
                    detections.append({'id': int(ident), 'class_id': int(cls), 'confidence': conf, 'box': [x1/width, y1/height, x2/width, y2/height]})
            report['last_detections'] = detections
            try:
                rows = weighted_presence(config, detections) if not reason else None
            except ValueError:
                rows, reason = None, 'ambiguous-or-malformed-observation'
            age = time.monotonic() - frame.decoded_mono
            processed += 1
            latencies.append(age * 1000)
            if time.monotonic() - last_publish >= 1 or args.max_frames and processed >= args.max_frames:
                seq += 1
                proposal = build_proposal(config, session, seq, rows, age, reason=reason, source_epoch=epoch)
                proposal.update({'frame_id': frame.sequence, 'media_time_s': frame.media_time, 'config_sha256': hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()})
                publisher.send(proposal)
                report['last_proposal'] = proposal
                last_publish = time.monotonic()
            if args.max_frames and processed >= args.max_frames:
                break
    finally:
        capture.close()
        seq += 1
        try:
            publisher.send(build_proposal(config, session, seq, None, math.inf, reason='agent-stopped', source_epoch=epoch))
        except Exception as exc:
            report['shutdown_publish_error'] = type(exc).__name__
        finally:
            publisher.close()
        elapsed = time.monotonic() - started
        ordered = sorted(latencies)
        report.update({'processed_frames': processed, 'elapsed_wall_s': elapsed, 'effective_fps': processed/elapsed if elapsed else 0, 'decode_arrival_to_observation_p95_ms': ordered[math.ceil(.95*len(ordered))-1] if ordered else None, 'transport': 'local-http-simulator' if args.simulator_url else 'mqtt-simulator-topic' if args.broker else 'stdout-only'})
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
