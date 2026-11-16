"""Reproducible transport fixture, not traffic accuracy ground truth."""
from pathlib import Path
import argparse
import os
import subprocess
import cv2
import numpy as np

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--seconds',type=int,default=18)
parser.add_argument('--output',default='validation/transport-long-fixture.webm')
args=parser.parse_args()
if not 1<=args.seconds<=120:
    parser.error('Use a fixture duration between 1 and 120 seconds')

root = Path(__file__).resolve().parents[1]
asset = root / 'validation' / 'yolo26-bus-sample.jpg'
image = cv2.imdecode(np.frombuffer(asset.read_bytes(), np.uint8), cv2.IMREAD_COLOR) if asset.is_file() else None
if image is None:
    raise SystemExit('Run the real inference smoke test to copy the public Ultralytics bus fixture first.')
target = (root / args.output).resolve()
if not target.is_relative_to(root / 'validation'):
    parser.error('Fixture output must stay in the project validation directory')
target.parent.mkdir(parents=True,exist_ok=True)
relative=os.path.relpath(target,root)
os.chdir(root)  # OpenCV's Windows filename API cannot handle this workspace's Unicode path.
image = cv2.resize(image, (1280, 720))
ffmpeg = root.parents[1] / '.tooling/browsers/ffmpeg-1013/ffmpeg-win64.exe'
if ffmpeg.is_file():
    _, encoded = cv2.imencode('.jpg', image)
    subprocess.run([str(ffmpeg), '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-r', '15',
                    '-i', 'pipe:0', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8',
                    '-y', relative], input=encoded.tobytes() * (15*args.seconds), check=True)
    print(target)
    raise SystemExit(0)
writer = cv2.VideoWriter(relative, cv2.VideoWriter_fourcc(*'VP90'), 15, (1280, 720))
if not writer.isOpened():
    raise SystemExit('VP9 WebM encoder unavailable')
for _ in range(15 * args.seconds):
    writer.write(image)
writer.release()
print(target)
