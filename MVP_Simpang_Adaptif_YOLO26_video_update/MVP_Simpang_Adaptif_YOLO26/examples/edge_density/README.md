# Contoh agen kepadatan YOLO26

Contoh Python untuk rekaman, RTSP atau USB: OpenCV → YOLO26 NMS-free → ByteTrack → presence berbobot dalam ROI → usulan durasi. Default keluaran adalah stdout. Opsi `--simulator-url` menghubungkan usulan ke simulator pada `/edge.html` melalui backend lokal. MQTT opsional hanya menggunakan namespace simulasi dan belum mempunyai adapter penerima. Lampu fisik belum terhubung.

**Presence bukan antrean berhenti.** Contoh belum mengukur waktu tunggu atau served count. Kontroler Mamdani dan pengamatan SRS pada aplikasi existing tetap terpisah. Bobot mobil 1, motor 0,25, bus 1,8, truk 2 hanyalah contoh eksperimen, bukan koefisien resmi PKJI.

## Menjalankan di Windows

Untuk melihat kendaraan simulator merespons usulan, jalankan `start.cmd`, buka **http://127.0.0.1:8000/edge.html**, kemudian pada terminal kedua jalankan:

```powershell
& "..\..\.venv\Scripts\python.exe" -X utf8 examples/edge_density/edge_agent.py --kind file --source "C:\rekaman\simpang.mp4" --weights weights/yolo26n.pt --simulator-url http://127.0.0.1:8000 --report validation/edge-recording-report.json
```

Tekan **Segarkan**, pilih sesi agen, lalu **Hubungkan simulator**. Satu sesi hanya menerima satu tab pengendali. Konfigurasi mengikuti salinan profil agen dan tidak dapat diedit selama sesi. Jeda/Lanjutkan membekukan/meneruskan jam serta kendaraan simulator; agen boleh terus membaca rekaman selama simulator dijeda. Akhir rekaman/Ctrl+C menandai sumber tidak valid, sementara simulator melanjutkan rencana cadangan. Tekan **Akhiri sesi** untuk menutup jurnal. Tombol ekspor JSON/CSV menampilkan usulan dan ACK penerapan sebenarnya, bukan hanya penerimaan HTTP.

Untuk demo singkat dengan fixture tersedia, tambahkan `--config validation/edge-browser-demo-config.json` dan gunakan `--source validation/transport-long-fixture.webm`. Profil tersebut hanya untuk foto bus berulang: minimum/cadangan 1 detik, maksimum 6 detik, kuning 0,3 detik dan semua merah 0,2 detik. **Durasi demo bukan parameter lampu fisik.** Profil normal tetap memakai minimum 10, maksimum 60, cadangan 30 detik; gunakan rekaman cukup panjang untuk beberapa siklus.

Simulator beroperasi pada tab browser yang aktif. Tab tersembunyi otomatis dijeda. Heartbeat yang hilang selama 5 detik atau restart backend menggagalkan sesi; jalankan agen sebagai sesi baru untuk memulai lagi. Usulan mempunyai TTL pengamatan dan ID frame; pengiriman ulang frame yang sama tidak memulihkan adaptif. Tiga pengamatan baru berjarak satu detik diperlukan sebelum adaptif. Durasi dipilih saat hijau aktif berakhir dan dibekukan selama clearance. Sumber harus tetap sehat dan epoch sama saat diterapkan; bila gagal, durasi cadangan menggantikannya.

Lima kelompok uji browser, termasuk 65 frame inferensi nyata, tersedia di [edge-browser-check.json](../../validation/edge-browser-check.json). Untuk mengulang pengujian integrasi, jalankan `node scripts/check-edge-browser.mjs` dengan `SIMPANG_URL` menunjuk backend lokal yang baru dijalankan dan `SIMPANG_CHROMIUM` menunjuk executable Chromium bila bukan instalasi default Playwright.

Jalankan dari folder proyek yang berisi `start.cmd`. Gunakan interpreter workspace yang sudah mempunyai requirements proyek:

```powershell
& "..\..\.venv\Scripts\python.exe" -X utf8 examples/edge_density/edge_agent.py --kind file --source "C:\rekaman\simpang.mp4" --weights weights/yolo26n.pt --report validation/edge-recording-report.json
```

Ubah `config.example.json`: polygon ternormalisasi harus cocok dengan kamera, tidak bertumpuk/bersinggungan, dan empat gerakan dilayani eksklusif dalam urutan siklik. Bobot serta batas durasi juga memerlukan kalibrasi. Simpan profil sendiri, lalu gunakan `--config "profil-kamera.json"`. Ctrl+C menghentikan program dan mengirim status tidak valid melalui transport yang dipilih. EOF juga mengakhiri sumber.

Uji ulang smoke test yang tersedia:

```powershell
& "..\..\.venv\Scripts\python.exe" -X utf8 examples/edge_density/edge_agent.py --kind file --source validation/transport-long-fixture.webm --config validation/edge-density-demo-zones.json --weights weights/yolo26n.pt --max-frames 5 --report validation/edge-density-smoke.json
& "..\..\.venv\Scripts\python.exe" -m unittest tests.test_edge_example -v
```

Fixture tersebut berupa foto bus publik yang diulang menjadi video. ROI demonstrasi sengaja mencakup bus; ini tidak memvalidasi geometri kamera simpang, gerak kendaraan, atau akurasi.

Untuk sumber lain, sesuaikan argumen berikut. Jalur ini diimplementasikan tetapi belum diuji dengan perangkat nyata:

```powershell
# USB
& "..\..\.venv\Scripts\python.exe" examples/edge_density/edge_agent.py --kind usb --source 0

# RTSP: isikan URL lewat environment agar tidak menempel di argumen proses.
# Atur TRAFFIC_SOURCE secara lokal; jangan memasukkan kredensial ke repository.
& "..\..\.venv\Scripts\python.exe" examples/edge_density/edge_agent.py --kind stream
```

Mode file melakukan pacing indeks/FPS dan memproses frame terbaru, sehingga frame dapat dilewati bila inferensi lebih lambat. Ini contoh operasi live-like, bukan alat evaluasi seluruh frame/VFR. Inferensi selalu menggunakan `nms=False`. Backend non-NMS-free ditolak; ekspor ulang checkpoint bila graph ONNX/engine berbeda. Gunakan `--device 0` pada CUDA yang sudah dikonfigurasi, `--imgsz 640` untuk ukuran awal, dan ukur ulang dampaknya terhadap recall serta latensi.

## MQTT opsional

Hanya bila perlu menguji dengan broker milik Anda, instal dependency tambahan dengan interpreter yang sama:

```powershell
& "..\..\.venv\Scripts\python.exe" -m pip install -r examples/edge_density/requirements.txt
& "..\..\.venv\Scripts\python.exe" examples/edge_density/edge_agent.py --kind file --source "C:\rekaman\simpang.mp4" --broker mqtt.example.local --port 8883 --ca "C:\sertifikat\ca.pem"
```

Gunakan `MQTT_USERNAME`/`MQTT_PASSWORD` sebagai environment lokal bila broker memerlukan autentikasi. TLS selalu aktif; jangan menonaktifkan pemeriksaan sertifikat. Program tidak membuat broker, akun, sertifikat, atau consumer kontroler.

Topik usulan: `traffic/sim/simpang-demo/plan/proposed`. Publisher memakai QoS 1, tidak retained, MQTT 5 expiry, satu pesan in-flight/queued. Pesan mempunyai sesi, sequence, epoch, validitas, batas durasi dan masa berlaku UTC. Broker PUBACK bukan ACK penerapan lampu. Consumer perlu deduplikasi, validasi konfigurasi, pengecekan konflik/TTL, ACK aplikasi, state machine fase dan watchdog lokal sebelum integrasi apa pun. Nilai nol yang valid dibedakan dari `valid=false`, `rows=null`, `green_s=null`.

Kolom latensi laporan adalah **decode-arrival ke observasi**, belum kamera-exposure ke snapshot. Timestamp sumber CCTV, buffer internal decoder, ACK kontroler dan akurasi lapangan belum diukur oleh contoh ini. Persiapan model tidak termasuk interval FPS laporan.

Validitas contoh memeriksa ketersediaan/kesegaran frame dan hasil tracker. Pemeriksaan kamera tertutup, citra beku meski frame terus dikirim, kualitas malam/hujan dan emergency classifier masih perlu ditambahkan serta dikalibrasi. Gambar hitam yang berhasil dibaca belum otomatis dibedakan dari jalan kosong oleh contoh ini.

Lihat [rancangan lengkap](../../docs/EDGE_AI_TRAFFIC_DESIGN.md) untuk arsitektur, rumus dengan waktu tunggu, anti-starvation, komunikasi PLC/Serial, preemption darurat, kualitas pengamatan dan rencana penerimaan.
