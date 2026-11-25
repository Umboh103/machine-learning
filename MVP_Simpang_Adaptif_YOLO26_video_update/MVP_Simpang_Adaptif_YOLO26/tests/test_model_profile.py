import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.model_profile import load_model_profile


class ModelProfileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / 'weights').mkdir()
        (self.root / 'weights/best.pt').write_bytes(b'trained-checkpoint')
        (self.root / 'model-config.json').write_text(json.dumps({
            'weights': 'weights/best.pt', 'vehicleClasses': list(range(7)),
            'classNames': {'1': 'bus'}, 'confidence': .3, 'imgsz': 640}), encoding='utf-8')
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_trained_checkpoint_and_matching_class_defaults(self):
        weights, profile = load_model_profile(self.root)
        self.assertEqual(weights, self.root / 'weights/best.pt')
        self.assertEqual(profile['vehicleClasses'], list(range(7)))
        self.assertEqual(profile['classNames']['1'], 'bus')
        self.assertEqual(profile['imgsz'], 640)
        self.assertEqual(len(profile['weights_sha256']), 64)
        self.assertEqual(profile, load_model_profile(self.root)[1])
        weights.write_bytes(b'retrained-checkpoint')
        self.assertNotEqual(profile['id'], load_model_profile(self.root)[1]['id'])

    def test_onnx_uses_the_trained_model_export_with_matching_classes(self):
        weights, profile = load_model_profile(self.root, engine='onnx')
        self.assertEqual(weights.name, 'best.onnx')
        self.assertEqual(profile['vehicleClasses'], list(range(7)))

    def test_explicit_official_checkpoint_keeps_coco_defaults(self):
        os.environ['YOLO_WEIGHTS'] = 'weights/yolo26n.pt'
        weights, profile = load_model_profile(self.root)
        self.assertEqual(weights.name, 'yolo26n.pt')
        self.assertEqual(profile['vehicleClasses'], [2, 3, 5, 7])
        self.assertEqual(profile['classNames'], {})
        weights, profile = load_model_profile(self.root, override='weights/best.pt')
        self.assertEqual(weights.name, 'best.pt')
        self.assertEqual(profile['vehicleClasses'], list(range(7)))

    def test_checkout_without_a_profile_keeps_the_original_defaults(self):
        (self.root / 'model-config.json').unlink()
        weights, profile = load_model_profile(self.root)
        self.assertEqual(weights.name, 'yolo26n.pt')
        self.assertEqual(profile['vehicleClasses'], [2, 3, 5, 7])


if __name__ == '__main__':
    unittest.main()
