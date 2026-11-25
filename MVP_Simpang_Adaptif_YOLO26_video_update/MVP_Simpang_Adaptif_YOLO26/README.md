# Simpang Adaptif YOLO26

## Model hasil training Kaggle

Konfigurasi lokal pada `model-config.json` memilih `weights/best.pt`, confidence 0,25 dan ukuran inferensi 640. Checkpoint `weights/best.pt` disertakan di repositori agar hasil clone memakai model training yang sama. Kelas model: `0 bicycle`, `1 bus`, `2 car`, `3 motorbike`, `4 rickshaw`, `5 truck`, `6 van`. Ketujuh kelas dihitung sebagai kendaraan.

Jalankan `start.cmd` seperti biasa. Dashboard menampilkan nama bobot aktif dan menyesuaikan kelas/ukuran inferensi saat identitas model berubah; ROI dan pengaturan lampu tetap dipertahankan. Konfigurasi/profil kamera lama juga disesuaikan ketika dimuat. Pilihan kelas dan threshold yang diedit untuk model yang sama tetap dipertahankan.

`start.cmd --weights weights/yolo26n.pt` memilih model bawaan secara eksplisit. `YOLO_WEIGHTS` juga dapat memilih checkpoint; argumen `--weights` memiliki prioritas tertinggi. Untuk ONNX model hasil training, siapkan `weights/best.onnx` sebelum menjalankan `start.cmd --engine onnx`. Kinerja/akurasi ukuran 640 pada video lokasi tetap perlu diukur.

Aplikasi lokal untuk memakai **berkas rekaman CCTV sebagai pengamatan dan simulator sebagai keluaran lampu**. YOLO26/ByteTrack mengukur kendaraan pada rekaman; Mamdani menentukan hijau berikutnya; lampu itu menggerakkan kendaraan sintetis pada panel simulator. Versi 0.3.1 diperbarui 16 November 2026. Akurasi lapangan, target performa SRS dan KPI belum diterima.

Untuk pengembangan Edge-AI/IoT, tersedia [rancangan YOLO26, SMP, fase dan komunikasi kontroler](docs/EDGE_AI_TRAFFIC_DESIGN.md) beserta [agen Python dan simulator Edge](examples/edge_density/README.md). Versi 0.3.1 menghubungkan agen ke halaman `/edge.html` melalui HTTP lokal, dengan penerapan durasi, ACK simulator, jurnal dan ekspor. Jalur ini memakai presence berbobot dan terpisah dari antrean/waktu tunggu Mamdani pada dashboard utama. MQTT masih berupa contoh publisher; keluaran perangkat fisik belum tersedia.

## Agen Python ke simulator Edge

Jalankan backend terbaru dengan `start.cmd`, lalu buka **http://127.0.0.1:8000/edge.html**. Dari terminal kedua pada folder proyek:

```powershell
& "..\..\.venv\Scripts\python.exe" -X utf8 examples/edge_density/edge_agent.py --kind file --source "C:\rekaman\simpang.mp4" --weights weights/yolo26n.pt --simulator-url http://127.0.0.1:8000 --report validation/edge-recording-report.json
```

Ubah ROI pada `examples/edge_density/config.example.json` sesuai kamera, atau berikan `--config profil-kamera.json`. Di halaman Edge, tekan **Segarkan**, pilih sesi agen lalu **Hubungkan simulator**. Gunakan **Jeda/Lanjutkan**, **Akhiri sesi**, dan **Ekspor JSON/CSV**. Akhir rekaman menghentikan masukan agen; simulator beralih ke cadangan sampai operator mengakhirinya. Konfigurasi tidak dapat diubah di tengah sesi. Simulator memerlukan tab aktif dan satu tab pengendali per sesi.

Bukti tambahan: **68/68 uji JavaScript**, **33/33 uji Python dengan inferensi nyata**, lima kelompok [uji browser Edge](validation/edge-browser-check.json), serta sembilan kelompok [regresi dashboard utama](validation/browser-regression-edge-update.json). Uji integrasi Edge memproses 65 frame YOLO26 NMS-free/ByteTrack dan membuktikan ACK penerapan adaptif serta cadangan saat agen berhenti. Fixture berupa foto bus berulang dengan durasi fase demo dipercepat; ini bukan penerimaan video lapangan atau KPI SRS.

## Mulai dengan rekaman CCTV

Dari folder proyek yang berisi `start.cmd`, jalankan di PowerShell:

```powershell
.\start.cmd
```

Launcher memakai `.venv` Windows yang sama di root workspace, atau `.venv` lokal proyek bila workspace tersebut tidak tersedia. Buka alamat yang ditampilkan. Untuk runtime ONNX yang sudah terpasang dan port alternatif:

```powershell
.\start.cmd --engine onnx --port 8010
```

Jika port sedang dipakai, pilih port lain atau tutup instance lama milik Anda. Launcher tidak menghentikan proses lain. Backend lama yang belum mendukung profil kamera ditandai oleh dashboard dan harus dijalankan ulang.

1. Buka **Konfigurasi** dan pilih sumber **Rekaman CCTV → pengendali simulator**. Muat MP4 H.264 atau WebM yang dapat diputar browser.
2. Tunggu dimensi, durasi dan status checksum muncul. Checksum berjalan pada worker, membaca potongan maksimum 4 MiB; seluruh berkas tidak dimuat ke satu buffer di tab utama. Penggantian berkas membatalkan pekerjaan sebelumnya.
3. Pilih dan muat profil kamera yang sudah tersimpan, atau gunakan **Profil baru**. Untuk profil baru, tandai keempat ROI dan garis keluar pada gambar, lalu simpan titik. Sesuaikan arah perlintasan.
4. Periksa posisi ROI terhadap sudut kamera, centang konfirmasi geometri, lalu **Simpan konfigurasi**. Berkas baru dan profil yang dimuat ulang selalu memerlukan pemeriksaan ulang. Profil dengan rasio gambar berbeda ditolak untuk pemakaian langsung; buat profil baru dan tandai ulang.
5. Isi nama kamera dan pilih **Simpan / perbarui profil** jika profil akan dipakai pada rekaman lain. Profil disimpan di tabel `camera_profiles` dalam SQLite yang sama dengan jurnal sesi. Versi konfigurasi setiap sesi tetap berupa salinan dan tidak berubah saat profil diperbarui.
6. Buka **Pemantauan**, lalu **Mulai sesi**. Persiapan model selesai sebelum pemutaran dimulai. Video atas memperlihatkan deteksi/ID; panel bawah memperlihatkan kendaraan sintetis yang mengikuti lampu hasil pengamatan rekaman.
7. Jeda membekukan video, jam dan kendaraan simulator; snapshot terakhir tetap dapat diperiksa. Lanjut meneruskan sesi. Akhir berkas atau tombol Akhiri menutup sesi dan menyimpan ringkasan. Ekspor JSON/CSV atau buka riwayat tersimpan pada Log sesi.

Tombol Mulai tetap nonaktif selama backend belum terhubung, rekaman/checksum belum siap, konfigurasi belum disimpan atau geometri belum dikonfirmasi. Pengaturan fase dan detektor berada pada bagian lanjutan; operator dapat memakai ulang profil kamera tanpa mengedit JSON pada setiap sesi.

Video asli tetap mengikuti kejadian yang telah direkam. Kendaraan pada panel keluaran adalah skenario sintetis berdasarkan arus/seed konfigurasi. Antrean sintetis tidak masuk ke Mamdani pada mode rekaman. Ekspor menandai data ini sebagai `simulator_output` dan `simulator_summary`, terpisah dari `track_measurement` dan `snapshot` rekaman. Alur ini tidak mengukur dampak pengubahan lampu terhadap lalu lintas dalam video.

Sesi berjalan bersama tab dashboard dan dijeda bila tab disembunyikan. Aplikasi ini tidak menyediakan pemrosesan rekaman tanpa dashboard yang aktif, masukan RTSP/USB, atau koneksi pengendali lampu fisik.

## Bukti versi 0.3

- 60/60 uji JavaScript lulus, termasuk pemisahan pengamatan dari telemetri keluaran, respons kendaraan hijau/merah dan SHA-256 lintas batas potongan.
- 17/17 uji backend lulus pada PyTorch dan ONNX; profil kamera diuji simpan/muat ulang/perbarui, dimensi/koordinat/nama tidak valid, isolasi konfigurasi sesi dan inferensi nyata.
- Sembilan kelompok browser lulus pada ONNX, termasuk keputusan Mamdani yang diterapkan ke simulator, pembekuan data saat jeda, profil tersimpan, checksum, EOF dan kegagalan jurnal.
- Worker browser diuji dengan File 9 MiB: tiga potongan, SHA-256 sama dengan Node crypto, pembatalan menghasilkan `AbortError`. Berkas multi-GB belum diuji sebagai stress test, walaupun pembacaan memakai potongan tetap.

Laporan terkini: [browser-check.json](validation/browser-check.json), [file-worker-check.json](validation/file-worker-check.json), dan [recorded-workflow.json](validation/recorded-workflow.json). Uji browser menggunakan video gambar publik berulang, bukan rekaman persimpangan beranotasi. Pada uji terakhir, 101 frame diproses dalam 15,69 detik aktif: 6,44 FPS dan p95 capture-ke-snapshot 380 ms pada 1280×720, model ONNX berinput tetap 384×640. Target 10 FPS belum tercapai. Metadata inferensi mencatat ukuran yang diminta terpisah dari ukuran input model sebenarnya.

Bagian berikut memuat detail arsitektur, pengujian serta hasil awal 12 November. Hasil lama tetap diberi lingkup dan tidak dianggap sebagai penerimaan kamera baru.

Sumber kebutuhan diekstrak tanpa mengubah dokumen ke [validation/srs-v0.1.txt](validation/srs-v0.1.txt). SHA256 dokumen asal: `40d127093040bcdb02a712dfc8bc3c8944ebc2766b8a707ba7603892fce5192f`. [MVP_STATUS.md](MVP_STATUS.md) memetakan setiap FR, AT, NFR, dan KPI ke implementasi serta bukti yang masih diperlukan. Bagian status prototipe dalam SRS menjelaskan kondisi paket lama, bukan hasil penerimaan kode saat ini.

## Menjalankan di Windows

Gunakan Python 3.10+ dan Node.js 20+ untuk pengujian JavaScript. Jalankan perintah dari folder yang berisi `requirements.txt`, yaitu `MVP_Simpang_Adaptif_YOLO26_video_update/MVP_Simpang_Adaptif_YOLO26`.

Workspace ini sudah memiliki virtual environment dua folder di atas proyek:

```powershell
& "..\..\.venv\Scripts\python.exe" -m pip install -r requirements.txt
& "..\..\.venv\Scripts\python.exe" -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Buka **http://127.0.0.1:8000**. Instalasi paket yang berakhir dengan `Successfully installed` berhasil; pemberitahuan versi pip tidak menghalangi aplikasi. `requirements.txt` sekarang mencantumkan `lap`, yang diperlukan ByteTrack. Aktivasi PowerShell tidak diperlukan jika interpreter dipanggil langsung.

Untuk checkout mandiri tanpa environment tersebut:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Semua mode memakai backend untuk jurnal sesi. Buka aplikasi melalui server, karena dashboard menggunakan ES modules. Model dimuat pada inferensi pertama dan bobot awal dapat memerlukan internet. Bobot default mengikuti `model-config.json` (`weights/best.pt` pada konfigurasi ini); tanpa berkas konfigurasi model, default adalah `weights/yolo26n.pt`. `YOLO_WEIGHTS` dapat menunjuk bobot lokal alternatif. Identitas bobot dan checksum dicatat. Bobot custom harus sesuai dengan kelas kendaraan dalam konfigurasi.

## Menyiapkan dan menjalankan sesi

1. Pada **Konfigurasi**, pilih sumber: referensi telemetri, simulator visual, atau video lokal. Pilih mode adaptif atau tetap. Video lokal memakai browser komputer yang menjalankan backend.
2. Untuk video, pilih berkas. Dashboard menghitung SHA256 sumber. Tandai poligon ROI dan garis keluar pada pratinjau, lalu simpan. ROI memakai koordinat 0–1 dan harus disesuaikan dengan geometri sumber. Titik acuan kendaraan adalah tengah sisi bawah bounding box.
3. Tetapkan arah garis: `outward` berarti dari sisi ROI ke luar; `positive` berarti sisi negatif ke positif garis A→B; `negative` berarti sebaliknya. Perlintasan balik tidak menambah hitungan. Kendaraan terlayani video merupakan estimasi tracking, sekali per ID dan arah dalam sesi.
4. Periksa JSON fase, urutan, peta konflik, fuzzy, dan profil pengamatan/detektor. Simpan konfigurasi. Semua ROI harus dilayani; gerakan berkonflik tidak boleh hijau bersama. Simpan/muat JSON untuk memakai konfigurasi yang sama kembali.
5. Pada **Pemantauan**, mulai sesi. Jeda membekukan jam simulasi dan sisa fase; lanjut meneruskan sesi. Konfigurasi tetap dikunci selama berjalan maupun dijeda. Akhiri sesi untuk mengubah definisi pengukuran atau pengendali.
6. Ekspor JSON/CSV atau buka **Riwayat tersimpan**. Akhir video normal mengakhiri sesi; kegagalan pipeline menandai data tidak valid dan tetap membiarkan transisi lampu selesai. Kegagalan pencatatan wajib menghentikan sesi dengan status gagal; finalisasi yang belum diakui server tetap berada dalam antrean untuk dicoba ulang.

Pilih sumber sesuai tujuan pengujian:

| Sumber | Masukan pengendali | Penggunaan dan batas |
| --- | --- | --- |
| Referensi telemetri | Antrean simulator | Uji algoritma, fase, dan eksperimen awal; tidak menguji persepsi visual. |
| Rekaman CCTV | Frame → YOLO26 → ByteTrack → Observer → Mamdani | Lampu mengendalikan simulator sintetis terpisah. Kendaraan dalam rekaman tetap tidak berubah. |
| Simulator visual | Render frame → YOLO26 → ByteTrack → Observer | Jalur umpan balik tersedia. Telemetri acuan hanya untuk evaluasi, tidak menggantikan deteksi. Renderer prosedural belum tervalidasi dan belum diterima untuk uji dampak. |

Akuisisi kamera langsung belum memiliki antarmuka khusus. Aplikasi ditujukan untuk penggunaan lokal pada komputer proyek; tidak menyediakan autentikasi pengguna atau penetapan retensi rekaman lapangan. Pemilik proyek perlu menetapkan akses dan retensi sebelum menggunakan data lapangan.

## Pengukuran dan pengendali

Antrean menggunakan ID unik, titik acuan dalam ROI, dan laju perpindahan dalam satuan tinggi ROI/detik pada jendela sekitar satu detik. Profil awal: masuk antrean pada laju ≤0,01 selama satu detik; bergerak kembali pada laju >0,02 selama 0,5 detik. Setelah konfirmasi berhenti, waktu tunggu dihitung sejak awal rentang teramati. Track hilang dipertahankan maksimal satu detik dengan penanda estimasi tanpa menambah waktu celah. Riwayat tunggu ringkas dapat disambung jika ID yang sama muncul kembali; ID baru mulai dari nol. Akhir sesi mengekspor track yang pengamatannya belum lengkap.

Observer diperbarui per frame yang berhasil diproses. Snapshot pengendali dipublikasikan setiap satu detik, membawa Q, W maksimum, W rata-rata, timestamp media/pengendali, usia, validitas, dan estimasi per ROI/fase. Pengamatan sehat kosong bernilai nol; data tidak tersedia bernilai null dengan alasan. Agregasi fase menggabungkan ID tanpa duplikasi. Usia dihitung pada basis jam yang sama; data dari masa depan dan data berusia lebih dari dua detik tidak boleh dipakai.

Pada akhir hijau aktif, pengendali memilih **fase berikutnya sesuai urutan konfigurasi**, mengambil satu snapshot valid fase itu, dan membekukan keputusan. Q fase adalah jumlah kendaraan unik dan W fase adalah tunggu maksimum. Kuning tiga detik dan semua merah satu detik dijalankan penuh pada profil awal. Gangguan tidak memotong hijau aktif atau keputusan yang sudah dibekukan.

Profil Mamdani awal:

| Variabel | Himpunan |
| --- | --- |
| Q, 0–30 kendaraan | sedikit trap(0,0,3,8); sedang tri(5,15,25); banyak trap(18,25,30,30) |
| W, 0–120 detik | singkat trap(0,0,10,30); sedang tri(20,60,100); lama trap(80,100,120,120) |
| G, 10–60 detik | pendek trap(10,10,15,25); sedang tri(20,35,50); panjang trap(45,55,60,60) |

Sembilan aturan mengikuti tabel SRS: baris sedikit → pendek/sedang/panjang; sedang → sedang/sedang/panjang; banyak → panjang/panjang/panjang. Operator DAN dan implikasi memakai minimum, agregasi maksimum, dan centroid integrasi trapesium 0,1 detik. Q/W melebihi domain dijepit; nilai mentah dan hasil penjepitan tetap dicatat. Centroid dijepit ke batas fase, dibulatkan ke tick 0,1 detik, lalu dijepit lagi.

Konfigurasi `phases` berisi `name`, `rois`, dan opsional `gmin`, `gmax`, `fixed`, `initial`; `phaseOrder` menyebut indeks fase; `conflictMap` adalah matriks boolean simetris antar-ROI. Profil awal memiliki empat fase lurus, satu ROI per fase, urutan Utara–Timur–Selatan–Barat. Default hijau awal/cadangan 30 detik per fase. Batas global dapat diubah jika domain keluaran `fuzzy.green` ikut disesuaikan dan menutupi domain tanpa celah. Batas per fase harus berada dalam domain global; durasi awal/cadangan harus berada dalam batas fase.

Implementasi saat ini menyediakan empat ROI yang dapat diberi label pergerakan dan dikelompokkan ke fase. Lokasi dengan lebih dari empat pergerakan terpisah, misalnya tambahan ROI belokan, memerlukan perluasan jumlah ROI serta antarmukanya sebelum profil tersebut dapat diterima.

Snapshot tidak valid/kedaluwarsa atau kegagalan fuzzy memakai rencana tetap fase tujuan. Penanda cadangan muncul dalam satu tick. Pemulihan memerlukan tiga snapshot valid berturut-turut pada publikasi satu detik, dengan timestamp observasi yang berbeda; perubahan adaptif berlaku pada keputusan berikutnya. Log mencatat awal gangguan, pemulihan, keputusan cadangan, dan waktu penerapan. Pada profil empat fase dengan maksimum hijau 60 detik, batas dari akhir hijau sampai hijau fase yang sama kembali adalah 196 detik, di luar jeda operator.

Pada model hasil training yang aktif, `vehicleClasses` default `[0,1,2,3,4,5,6]`, `confidence` 0,25, dan `imgsz` 640, sesuai `model-config.json`. Model bawaan COCO memakai `[2,3,5,7]`. Mengubah ukuran inferensi mengubah profil pengamatan dan memerlukan validasi akurasi baru.

## Penyimpanan dan ekspor

Backend menyimpan sesi dan kejadian dalam `data/sessions.sqlite3` dengan transaksi SQLite, WAL, serta `synchronous=FULL`. `SIMPANG_DATA_DIR` dapat memilih direktori data lain. Jurnal memuat identitas sesi/sumber, hash konfigurasi dan video, perangkat, metadata bobot/tracker, observasi mentah, pengukuran track, snapshot, keputusan, transisi, gangguan, lifecycle, dan ringkasan yang tersedia.

Browser menyimpan operasi yang belum diakui dalam outbox `localStorage` dengan ID kejadian untuk deduplikasi. Finalisasi mengikuti urutan log dan dicoba ulang setelah kegagalan; tab yang dimuat ulang dapat menyinkronkan antrean. Kehilangan akses penyimpanan lokal/server menghentikan sesi; penyimpanan yang benar-benar gagal tetap membatasi kelengkapan catatan terakhir. Berkas SQLite dan data browser memiliki siklus hidup terpisah; riwayat server dapat dibaca kembali setelah backend dijalankan ulang.

Endpoint lokal: `GET /api/sessions`, `GET /api/sessions/{id}/export?format=json`, dan `?format=csv`. JSON membawa konfigurasi/kejadian/satuan; CSV memuat tabel snapshot dan data kejadian. Hash berkas sumber hanya tersedia untuk sumber berkas; simulator memakai metadata konfigurasi dan checksum jadwal kedatangan pada evaluator.

## Pengujian otomatis

```powershell
node --test tests/*.test.mjs
& "..\..\.venv\Scripts\python.exe" -m unittest discover -s tests -p test_backend.py -v
```

Pengujian backend biasa menggunakan fixture inferensi yang diberi label. Untuk smoke test model sungguhan pada gambar `bus.jpg` bawaan Ultralytics:

```powershell
$env:SIMPANG_REAL_INFERENCE = "1"
& "..\..\.venv\Scripts\python.exe" -m unittest discover -s tests -p test_backend.py -v
```

Bukti yang sudah diperiksa: 34 uji core lulus, delapan uji outbox lulus, dan 17 uji backend lulus termasuk inferensi YOLO26/ByteTrack nyata, ID antarframe, isolasi sesi, reset tracker, serta jalan kosong valid. Hasil renderer/evaluator dan pemeriksaan browser dicatat terpisah dalam [MVP_STATUS.md](MVP_STATUS.md). Smoke gambar publik/buatan bukan pengujian akurasi lalu lintas.

`scripts/browser-check.mjs` menguji lifecycle, penguncian, ekspor, video, dan kegagalan pencatatan pada browser headless; memerlukan Playwright dan Chromium. Sembilan kelompok pengujian browser lulus tanpa error JavaScript; lihat `validation/browser-check.json`. Video contoh mengulang gambar publik dan tidak membuktikan akurasi lalu lintas.

## Benchmark perangkat

```powershell
& "..\..\.venv\Scripts\python.exe" scripts/benchmark.py --frames 30 --warmup 3 --threads 4 --output validation/backend-benchmark.json
& "..\..\.venv\Scripts\python.exe" scripts/benchmark.py --video "C:\data\persimpangan.mp4" --frames 300 --warmup 10 --output validation/my-video-benchmark.json
```

Hasil aktual pada Windows 11, Python 3.13.6, Torch 2.15.0 CPU, empat thread, tanpa CUDA:

| Masukan dan profil inferensi | Sampel setelah warmup | FPS efektif | p95 ke observasi mentah |
| --- | --- | --- | --- |
| Frame kosong sintetis 1280×720, profil 1280 | 30 | 2,03 | 721 ms |
| Frame kosong sintetis 1280×720, `imgsz=640` | 20 | 5,04 | 248 ms |

Lihat [backend-benchmark.json](validation/backend-benchmark.json) dan [backend-benchmark-640-threads4.json](validation/backend-benchmark-640-threads4.json). Waktu mencakup encode JPEG, transport TestClient, inferensi/tracking, dan penyimpanan observasi; belum mencakup browser, jaringan, dan publikasi snapshot Observer. NFR04 **belum lulus**: target ≥10 FPS dan p95 frame-ke-snapshot ≤1 detik harus dibuktikan pada satu video 1280×720 yang representatif. Hasil profil 640 tidak membuktikan akurasi atau penerimaan profil default.

## Kalibrasi dan evaluasi

Kalibrasikan baseline pada data pengembangan, kemudian kunci sebelum uji akhir:

```powershell
node scripts/evaluate-visual.mjs --calibrate
node scripts/evaluate-visual.mjs --lock validation/baseline-development.json
node scripts/evaluate-visual.mjs --smoke --seconds 3 --backend http://127.0.0.1:8000
node scripts/evaluate-visual.mjs --run --baseline validation/baseline-lock.json --backend http://127.0.0.1:8000
node scripts/evaluate-annotations.mjs validation/my-annotations.json validation/annotation-evaluation.json
```

Kalibrasi tersedia untuk kandidat hijau 20/30/40/50/60 detik, tiga tingkat arus, dan lima seed pengembangan 101–105: **75 sesi, masing-masing 1800 detik, dengan pemanasan 300 detik**. Data ini memakai simulator prosedural untuk memilih baseline, bukan anotasi atau penerimaan dampak. Hasil dan pilihan tersimpan pada `baseline-development.json`; `baseline-lock.json` mengikat checksum konfigurasi, kalibrasi, dan source simulator. Perubahan source/konfigurasi mengharuskan kalibrasi dan lock ulang. Seed uji 1–5 terpisah dari seed pengembangan. Gunakan `--config profil.json` yang sama pada seluruh langkah ketika memakai konfigurasi khusus.

Evaluasi penuh menjadwalkan 15 pasangan (tiga arus × lima seed), dua mode per pasangan, masing-masing 30 menit dengan 5 menit pemanasan dan 25 menit pengukuran. Pasangan berbagi geometri, rute, jenis kendaraan, antrean awal, jadwal kedatangan, seed, horizon, dan transisi. Setiap frame renderer benar-benar dikirim ke backend YOLO; telemetri acuan disimpan terpisah. Metrik mencakup semua kendaraan yang masuk jendela ukur, termasuk yang belum keluar; antrean rata-rata memakai integral berbobot waktu; throughput memakai keluaran dalam jendela ukur. Laporan memuat metrik per arah/pasangan/gabungan, variasi pasangan, interval bootstrap, sisa kendaraan, pemerataan, dan kegagalan.

Smoke visual terbaru memproses 24 frame dalam dua sesi tiga detik; semua deteksi kosong walaupun simulator memiliki kendaraan. Jalur transport/inferensi berjalan, tetapi cakupan detektor pada renderer belum layak untuk penerimaan FR16/KPI. Lima belas pasangan visual akhir belum dijalankan sebagai uji penerimaan. Selesaikan validasi renderer/persepsi dan performa perangkat sebelum memakai hasil untuk klaim dampak.

Uji anotasi memerlukan sedikitnya 300 pasangan ROI/timestamp dan 60 lintasan, interval hitung keluar tetap, kondisi kosong/ringan/padat/motor/oklusi, dua penilai dengan selisih diselesaikan, checksum sumber, serta pemisahan klip/periode kalibrasi dan uji. [annotation-format.example.json](validation/annotation-format.example.json) adalah format contoh; laporan self-check hanya menguji evaluator. Dataset beranotasi yang memenuhi protokol belum tersedia.

`node scripts/experiment.mjs` menghasilkan referensi 15 pasangan berbasis telemetri. Untuk memakai baseline terkunci, jalankan `node scripts/experiment.mjs --baseline validation/baseline-lock.json --out validation/paired-telemetry-calibrated.json`. Pelaksanaan ini selesai: adaptif memiliki tunggu +14,97% dan antrean +16,78% terhadap baseline pada model prosedural. Hasil diberi label dan tidak memenuhi penerimaan visual.

## Struktur source

- `dist/index.html`, `style.css`, `dashboard.js`: dashboard dan lifecycle, publikasi snapshot, konfigurasi, serta ekspor.
- `dist/core.js`: validasi, Mamdani, fase, simulator antrean, dan Observer track.
- `dist/visual-simulator.js`: renderer prosedural, umpan balik persepsi, metrik, dan audit pasangan.
- `dist/session-log.js`: antrean log/finalisasi dengan percobaan ulang.
- `backend/app.py`, `backend/storage.py`: bridge inferensi per sesi dan jurnal SQLite.
- `tests/`: pengujian core, outbox, renderer/evaluator, transport, dan smoke model nyata opsional.
- `scripts/`: benchmark, evaluasi anotasi/visual, kalibrasi, eksperimen telemetri, dan pemeriksaan browser.
- `validation/`: ekstraksi SRS, protokol, serta bukti pengujian yang diberi lingkup.

Tahap berikutnya adalah menyediakan video dan anotasi yang dikunci, memastikan detektor mengenali kendaraan renderer dengan galat terukur, mencapai target perangkat, lalu menjalankan 15 pasangan visual dan melaporkan seluruh NFR/KPI termasuk yang gagal. Penggunaan simulator sederhana ini belum membuktikan perilaku lalu lintas nyata atau penerapan pada lampu fisik.


## Verifikasi lanjutan dan opsi ONNX

Jumlah akhir: 60/60 uji JavaScript (34 core, delapan outbox, 15 renderer/evaluator, tiga rekaman/checksum), 17/17 uji backend pada PyTorch, 17/17 pelaksanaan suite yang sama pada ONNX, dan sembilan kelompok browser lulus. Jalankan `node scripts/reliability-check.mjs` saat backend aktif untuk memverifikasi 1800 detik waktu simulasi dipercepat dan membaca kembali seluruh log. Pelaksanaan tersimpan pada `validation/reliability-check.json`: 1800 snapshot, 32 keputusan dan 128 transisi lengkap. Ini bukan uji ketahanan inferensi visual 30 menit.

ONNX mempercepat inferensi CPU dalam percobaan, tetapi belum mencapai target. Masukan tetap 1280×720; model diekspor dengan bentuk tetap 384×640. Pengukuran terakhir 7,54 FPS/p95 observasi mentah 364 ms; percobaan sebelumnya 8,75 FPS/173 ms. Default tetap `.pt`. Pengurangan ukuran inferensi harus dinilai ulang dengan anotasi.

Untuk menggunakan runtime opsional pada proses server baru:

```powershell
& "..\..\.venv\Scripts\python.exe" -m pip install -r requirements-onnx.txt
# Ekspor ulang jika file weights/yolo26n.onnx belum tersedia:
& "..\..\.venv\Scripts\python.exe" -c "from ultralytics import YOLO; YOLO('weights/yolo26n.pt').export(format='onnx', imgsz=(384,640), simplify=False, dynamic=False, opset=17)"
$env:YOLO_WEIGHTS = (Resolve-Path 'weights/yolo26n.onnx').Path
& "..\..\.venv\Scripts\python.exe" -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Sesuaikan `imgsz` profil detektor menjadi `[384,640]` sebelum memulai sesi ONNX. Untuk kembali ke default, tutup proses server tersebut, hapus variabel dengan `Remove-Item Env:YOLO_WEIGHTS`, lalu jalankan backend kembali. Bobot, perangkat dan konfigurasi tetap dicatat dalam sesi.

Pengujian browser menggunakan Playwright dan Chromium lokal. Pada instalasi standar: `npm.cmd install --no-save playwright`, `npx.cmd playwright install chromium`, buat klip contoh dengan `scripts/make-test-video.py`, lalu jalankan `node scripts/browser-check.mjs`. Workspace pengerjaan menyimpan dependensi pengujian pada `.tooling` di root workspace; skrip juga mendukung `SIMPANG_CHROMIUM` untuk path browser eksplisit.


Model disiapkan sebelum video diputar atau jam simulator berjalan. Proses ini memakai piksel kosong sebagai pemanasan, tidak menerbitkannya sebagai observasi sumber, dan mereset tracker sebelum frame pertama. Kegagalan persiapan menutup sesi sebagai gagal. Waktu persiapan tercatat pada event `model_ready` dan `model_startup_ms`, terpisah dari latensi capture-ke-snapshot. Uji browser dari backend dingin mencatat persiapan sekitar 11,28 detik dan frame sumber pertama pada timestamp 0,067 detik; rekaman pendek tidak terlewati selama model dimuat.


Profil kamera tersedia melalui `GET /api/profiles`, `GET /api/profiles/{id}`, `POST /api/profiles` dan `PUT /api/profiles/{id}`. Profil membawa nama, konfigurasi serta dimensi sumber. UI memvalidasi geometri/fase/fuzzy saat simpan dan muat; API memeriksa nama, dimensi, bentuk/koordinat finite dan profil inferensi. Sesi menyimpan salinan konfigurasi dan ID profil agar perubahan berikutnya tidak mengubah riwayat.

Untuk melihat keputusan adaptif dan pergantian fase, gunakan rekaman yang lebih panjang daripada hijau awal ditambah transisi. Default hijau awal 30 detik; berkas pendek dapat berakhir sebelum keputusan pertama. Sesuaikan durasi awal dalam batas valid bila diperlukan.

Uji worker terpisah: `node scripts/check-file-worker.mjs`. Launcher menerima `SIMPANG_DATA_DIR` untuk direktori SQLite seperti backend biasa; uji terisolasi dapat memakai direktori data berbeda. Tidak ada instalasi, konversi model, penghentian proses, atau unduhan paket otomatis pada `start.cmd`.
