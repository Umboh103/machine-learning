"""Resolve the selected local checkpoint and its matching detector defaults."""
import hashlib
import json
import os
from pathlib import Path


def load_model_profile(root, override=None, engine=None):
    root = Path(root).resolve()
    path = root / 'model-config.json'
    config = json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {}
    configured = root / config.get('weights', 'weights/yolo26n.pt')
    explicit = override or os.environ.get('YOLO_WEIGHTS')
    checkpoint = root / explicit if explicit else configured
    if not explicit and engine == 'onnx':
        checkpoint = checkpoint.with_suffix('.onnx')
    checkpoint = checkpoint.resolve()
    matching = checkpoint.with_suffix('') == configured.resolve().with_suffix('')
    settings = {'vehicleClasses': [2, 3, 5, 7], 'confidence': .25, 'imgsz': [736, 1280]}
    if matching:
        settings.update({key: config[key] for key in settings if key in config})
    profile = {**settings, 'weights': checkpoint.name,
               'classNames': config.get('classNames', {}) if matching else {},
               'weights_sha256': hashlib.sha256(checkpoint.read_bytes()).hexdigest() if checkpoint.is_file() else None}
    profile['id'] = hashlib.sha256(json.dumps(profile, sort_keys=True).encode()).hexdigest()
    return checkpoint, profile
