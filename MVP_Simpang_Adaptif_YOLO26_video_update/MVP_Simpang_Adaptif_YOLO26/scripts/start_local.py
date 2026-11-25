"""Run the recorded-CCTV/simulator dashboard with an explicit local runtime."""
import argparse
import importlib.util
import os
from pathlib import Path
import socket
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--engine', choices=['pytorch', 'onnx'], default='pytorch')
    parser.add_argument('--weights', help='Path checkpoint lokal; default mengikuti model-config.json')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('Port harus 1–65535')
    os.chdir(ROOT)
    sys.path.insert(0, str(ROOT))
    if importlib.util.find_spec('uvicorn') is None:
        raise SystemExit('Instal requirements.txt menggunakan interpreter virtual environment ini terlebih dahulu.')
    if args.engine == 'onnx' and importlib.util.find_spec('onnxruntime') is None:
        raise SystemExit('Runtime ONNX belum tersedia. Instal requirements-onnx.txt menggunakan interpreter ini.')
    from backend.model_profile import load_model_profile
    checkpoint, profile = load_model_profile(ROOT, override=args.weights, engine=args.engine)
    if not checkpoint.is_file():
        raise SystemExit(f'Bobot belum tersedia: {checkpoint}. Siapkan bobot lokal sebelum menjalankan aplikasi.')
    os.environ['YOLO_WEIGHTS'] = str(checkpoint)
    try:
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', args.port))
    except OSError:
        raise SystemExit(f'Port {args.port} sedang dipakai. Tutup proses terkait atau pilih --port lain.')
    print(f'Interpreter: {sys.executable}', flush=True)
    print(f'Runtime: {args.engine}; keluaran: simulator', flush=True)
    print(f'Model: {checkpoint.name}; kelas kendaraan: {profile["vehicleClasses"]}', flush=True)
    print(f'Buka http://127.0.0.1:{args.port}', flush=True)
    print('Pilih rekaman CCTV, muat/tandai profil kamera, konfirmasi ROI, lalu mulai sesi.', flush=True)
    import uvicorn
    uvicorn.run('backend.app:app', host='127.0.0.1', port=args.port, workers=1, access_log=False)


if __name__ == '__main__':
    main()
