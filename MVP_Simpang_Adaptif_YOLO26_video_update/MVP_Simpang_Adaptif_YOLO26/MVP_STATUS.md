# Keterlacakan implementasi terhadap SRS versi 0.1

Status diperbarui 16 November 2026 dan mengacu pada SRS 9 November 2026. Ekstraksi lengkap, termasuk urutan tabel dan SHA256 dokumen asal, tersedia di [validation/srs-v0.1.txt](validation/srs-v0.1.txt). Dokumen kebutuhan dipakai sebagai sumber persyaratan; status paket lama pada Bagian 9 tidak dianggap bukti penerimaan implementasi baru.

Implementasi dan penerimaan dibedakan. Fitur yang tersedia serta uji sintetis lulus tidak otomatis memenuhi akurasi, performa, ketahanan lapangan, atau KPI dampak. **Penerimaan keseluruhan MVP masih tertunda.**

## Kebutuhan fungsional wajib

Tambahan versi **0.3.1** menghubungkan agen Python NMS-free/ByteTrack ke simulator pada `/edge.html` melalui relay HTTP lokal. Ini contoh pengendali **presence berbobot**, bukan perubahan masukan atau algoritma Mamdani SRS. Penerima mengunci konfigurasi, menolak replay/ID frame berulang, membatasi satu tab pengendali, membekukan durasi, menjalankan clearance, memeriksa kesehatan saat penerapan dan memakai cadangan saat sumber berhenti. Timeout koneksi simulator atau restart backend menutup sesi gagal. Jurnal SQLite mencatat usulan, keputusan, transisi, ACK penerapan, keluaran sintetis dan lifecycle; ekspor JSON/CSV tersedia.

Bukti terbaru: **68/68 JavaScript**, **33/33 Python dengan inferensi nyata**, **5/5 kelompok browser Edge** dan **9/9 kelompok regresi dashboard utama**. Laporan: [edge-browser-check.json](validation/edge-browser-check.json), [edge-integrated-inference.json](validation/edge-integrated-inference.json), dan [browser-regression-edge-update.json](validation/browser-regression-edge-update.json). Inferensi Edge memproses 65 frame dari foto bus berulang; fase demo dipercepat untuk menguji penerapan. Kehadiran kendaraan di ROI tidak diperlakukan sebagai antrean berhenti/waktu tunggu. Bukti ini tidak mengubah status FR16/AT10/KPI atau menerima performa kamera-ke-snapshot. Angka dan bukti versi 0.3 pada bagian berikut dipertahankan sebagai riwayat.

| ID | Implementasi dan bukti | Batas penerimaan saat ini |
| --- | --- | --- |
| FR01 | Video berkas browser; timestamp media/frame, ukuran asal/hasil resize, koordinat normal, EOF dan error berbeda. Backend menguji resize/aspect ratio. | Kamera langsung belum memiliki UI khusus; uji rekaman persimpangan representatif belum tersedia. Alur browser pada video contoh lulus; rekaman lapangan belum divalidasi. |
| FR02 | Editor poligon/garis, empat label ROI, profil kamera SQLite simpan/muat/perbarui dan pemeriksaan rasio gambar/konfirmasi operator, JSON simpan/muat; validasi koordinat, area, self-intersection, overlap, dan pemetaan fase. | Jumlah ROI masih empat; tambahan pergerakan/belokan terpisah memerlukan perluasan. Geometri kamera sebenarnya belum dikalibrasi dan diuji terhadap anotasi. |
| FR03 | YOLO26n nyata untuk kelas konfigurasi; confidence, box, kelas, timestamp dan checksum bobot dicatat. Smoke gambar bus mendeteksi kelas bus. | Smoke gambar publik tidak membuktikan akurasi mobil/motor/bus/truk pada persimpangan atau renderer. |
| FR04 | ByteTrack dipilih eksplisit; state tracker dan jam frame diisolasi per sesi; metadata tracker diekspor. Uji ID berulang, isolasi dan reset lulus. | ID switch/fragmentasi/occlusion pada video lapangan belum dinilai. |
| FR05 | ID unik, bottom-center ROI, jendela satu detik, ambang 0,01/0,02, konfirmasi dan hysteresis; keluar ROI/bergerak/hilang diuji. | Antrean dan ambang kamera belum dibandingkan dengan anotasi manual. |
| FR06 | Selisih timestamp sumber; awal konfirmasi dibackdate; celah tidak menambah tunggu; archive ringkas menyambung ID sama, ID baru nol; track tidak lengkap diekspor. | Pencocokan track serta galat waktu tunggu teramati belum diukur pada dataset terkunci. |
| FR07 | Snapshot ROI/fase berisi Q unik, W maksimum/rata-rata, timestamp, usia, validitas, estimasi dan alasan; publikasi satu detik. Kosong valid nol, tidak tersedia null. | Publikasi dan ekspor snapshot satu detik diuji melalui browser; akurasi terhadap anotasi tetap belum diterima. |
| FR08 | Pilihan arah garis; perlintasan balik diabaikan; sekali per ID dan arah; contact endpoint serta hilangnya track diuji. Hitungan video dilabel estimasi. | WAPE per arah/interval dan positif palsu saat acuan nol belum diukur. |
| FR09 | Kelompok dari empat ROI/pergerakan, urutan tetap, matriks konflik simetris; konflik, urutan tidak lengkap/duplikat ditolak. Simulator melayani semua ROI fase aktif. | Jumlah ROI/pergerakan belum umum di luar empat. Peta konflik lokasi uji harus ditetapkan dan dikunci. Tidak ada pengubahan urutan dinamis. |
| FR10 | Mamdani memakai satu snapshot valid fase berikutnya; Q gabungan dan W maksimum; nilai mentah/jepit, aturan, centroid dan hijau akhir dicatat. Sembilan aturan/domain diuji. | Profil kamera/lokasi belum dikalibrasi dan dikunci untuk penerimaan akhir. |
| FR11 | Batas global/per fase, hijau awal, kuning dan semua merah penuh, keputusan dibekukan; tick yang melintasi banyak batas tetap menghasilkan semua transisi. Uji batas kembali fase 196 detik lulus. | Uji terpadu perangkat/sumber representatif masih diperlukan. |
| FR12 | Cadangan tetap per fase; invalid/kedaluwarsa/fuzzy gagal; penanda dalam satu tick; tiga snapshot satu detik berturut dengan observasi berbeda untuk pemulihan. Awal/pemulihan/penerapan tercatat. | Gangguan sumber, cadangan, kelanjutan jam/transisi dan pemulihan adaptif lulus pada browser. Gangguan tetap dipisahkan dari evaluasi dampak nominal. |
| FR13 | Video/render, ROI, box/kelas/ID, Q/W, lampu/countdown, mode, alasan validitas, usia dan statistik performa tersedia. | Sembilan kelompok uji browser lulus, termasuk status, video, ROI, ID, Q/W dan ekspor. Rekaman persimpangan representatif belum dinilai. |
| FR14 | SQLite WAL/FULL; outbox browser, retry/deduplikasi/finalisasi FIFO; checksum konfigurasi/video; observasi/track/snapshot/keputusan/transisi/gangguan; JSON/CSV dan riwayat server. Kegagalan jurnal menghentikan sesi gagal. | Uji backend/outbox lulus; crash mesin/disk, retensi, dan akses proyek belum divalidasi sebagai sistem produksi. Catatan terakhir tetap dibatasi kegagalan storage nyata. |
| FR15 | Mulai/jeda/lanjut/akhir, jam simulasi beku saat jeda, EOF normal, error sumber, status gagal, dan ringkasan/finalisasi tersedia. | Jeda/lanjut, jam beku, akhir berkas normal dan ekspor video lulus pada browser dengan klip contoh. Persiapan model diselesaikan sebelum pemutaran/jam dimulai; startup gagal menutup sesi gagal. |
| FR16 | Simulator visual → model nyata → Observer → Mamdani → lampu → simulator; truth terpisah. Kalibrasi development 75 sesi, baseline lock/checksum, 15 pasangan dan laporan tersedia sebagai tooling. | **Belum diterima:** renderer tidak menghasilkan deteksi pada smoke terbaru 24 frame; 15 pasangan visual akhir belum dinilai. Simulator/persepsi belum tervalidasi. |
| FR17 | Edit fase/konflik/durasi/fuzzy dikunci saat aktif/jeda; validasi bounds, durasi awal/cadangan per fase, cakupan membership tanpa celah, aturan, ROI dan inferensi. | Validasi otomatis serta penguncian UI saat aktif dan dijeda lulus. Profil lokasi harus dikunci sebelum evaluasi akhir. |

## Bukti pengujian otomatis

- Core: **34/34 lulus**, termasuk semua sembilan aturan SRS, domain/penjepitan/agregasi nol, celah membership sangat kecil, konflik/kelompok/order, bounds/fallback, timestamp, missing track, perlintasan terarah, recovery cadence, antrean berbobot waktu, serta maksimum interval kembali fase 196 detik.
- Outbox: **8/8 lulus**, mencakup retry, deduplikasi, finalisasi, persistensi antrean, dan kegagalan wajib yang memicu penghentian.
- Backend: **17/17 lulus** dalam mode inferensi nyata pada PyTorch dan ONNX, termasuk fixture transport/storage dan smoke YOLO26n/ByteTrack pada `bus.jpg` bawaan Ultralytics. Model nyata menghasilkan ID stabil pada pengulangan gambar, tracker terisolasi/reset, dan frame kosong valid. Ini tidak mengukur akurasi video lalu lintas.
- Renderer/evaluator: **15/15 lulus**, termasuk isolasi truth dari kontrol, publikasi, audit fase 30 menit, metrik berbobot, pemerataan, protokol anotasi dan class ID custom. Tiga uji tambahan rekaman/simulator dan checksum lulus; total JavaScript: **60/60 lulus**. Smoke model nyata pada `validation/visual-smoke.json` memuat kegagalan cakupan detektor, bukan kelulusan akurasi.
- Browser: **9/9 kelompok lulus**, tanpa error JavaScript. Meliputi lifecycle/config lock/JSON, CSV, penolakan konflik, gangguan dan pemulihan adaptif, editor ROI dan muat ulang koordinat, video/model nyata dengan ID/Q/W/resize/jeda/EOF, serta kegagalan jurnal yang menghentikan sesi gagal dan dapat disinkronkan. Bukti: [browser-check.json](validation/browser-check.json). Versi 0.3 menambahkan profil kamera, penerapan keputusan rekaman ke kendaraan simulator, serta pemeriksaan SHA-256 worker. Worker diuji terpisah pada berkas 9 MiB: [file-worker-check.json](validation/file-worker-check.json).

## Matriks penerimaan AT01–AT10

| Uji | Bukti yang diperiksa | Hasil dan pekerjaan tersisa |
| --- | --- | --- |
| AT01 — FR01–02 | Sumber/ROI muat ulang dan resize menjaga pemetaan. | Transport/koordinat backend, editor ROI pada ukuran tampilan, muat ulang JSON dan video browser lulus. Rekaman persimpangan representatif belum tersedia. |
| AT02 — FR03–07 | Kendaraan berhenti dihitung satu kali dan bergerak kembali keluar antrean. | Uji core sintetis lulus; inferensi bus nyata smoke. Validasi antrean pada video beranotasi belum dilakukan. |
| AT03 — FR05–07 | Hilang track, ID baru, kosong, lompatan timestamp. | Core/backend lulus untuk kasus sintetis, nonfuture age, celah waktu, ID baru dan reappearance. Belum ada bukti galat pengukuran lapangan. |
| AT04 — FR08 | Perlintasan sah sekali per ID/arah, balik tidak dihitung. | Uji segmen, endpoint, arah dan kehilangan lulus. Perbandingan anotasi garis/interval belum tersedia. |
| AT05 — FR10–11 | Sembilan aturan, ujung/overlap domain, clipping, agregasi nol. | Uji algoritma lulus, termasuk profil konfigurasi dan cakupan exact tanpa celah. |
| AT06 — FR09,11,17; NFR05 | Urutan, konflik, batas hijau/transisi/giliran, konfigurasi invalid. | Core lulus; interval kembali maksimum tepat 196 detik pada profil awal diuji. Integrasi visual/perangkat lokasi belum diterima. |
| AT07 — FR12; NFR06 | Putus sumber/pipeline, waktu cadangan, transisi dan pulih. | Core, backend dan outbox lulus. Browser membuktikan cadangan, jam/transisi yang berlanjut, pemulihan adaptif dan log kedua mode. |
| AT08 — FR15 | Jeda, lanjut, EOF, berhenti; jam/ringkasan konsisten. | Lifecycle storage, jeda/lanjut dengan jam beku, berhenti serta EOF normal pada browser video lulus; ringkasan dan log dapat diekspor. |
| AT09 — FR13–14 | Tampilan, ekspor lengkap, versi konfigurasi, gagal catat. | Hash, jurnal reopen, JSON/CSV, deduplikasi/finalisasi dan gagal storage diuji. Browser membuktikan tampilan, ekspor, penghentian gagal catat dan pemulihan antrean log. |
| AT10 — FR16; NFR01–07; KPI01–03 | Anotasi, benchmark perangkat, 15 pasangan visual, metrik arah/pasangan/gabungan dan semua kegagalan. | **Belum lulus:** anotasi tidak tersedia; FPS di bawah target; renderer belum dikenali; evaluasi visual akhir belum dijalankan sebagai penerimaan. |

## Target nonfungsional dan bukti aktual

| ID | Target SRS | Status |
| --- | --- | --- |
| NFR01 | MAE antrean ≤2 kendaraan/ROI dan p95 galat absolut ≤5 pada anotasi terkunci. | Belum diukur. Evaluator tersedia; data minimal 300 ROI/timestamp belum tersedia. |
| NFR02 | WAPE kendaraan terlayani ≤10% per arah/interval; acuan nol melaporkan galat absolut/positif palsu. | Belum diukur pada anotasi nyata. Hitungan renderer kosong bukan bukti akurasi. |
| NFR03 | MAE waktu tunggu teramati ≤3 detik pada track cocok dan proporsi cocok dilaporkan. | Belum diukur; sedikitnya 60 lintasan beranotasi dan pencocokan belum tersedia. |
| NFR04 | ≥10 FPS efektif pada video 1280×720 dan p95 frame→snapshot ≤1 detik; perangkat dicatat. | **Belum lulus.** CPU: 2,03 FPS/p95 observasi mentah 721 ms pada profil 1280; 5,04 FPS/248 ms pada 640. Kedua hasil mengabaikan browser/Observer snapshot, sehingga p95 tersebut tidak menerima target end-to-end. |
| NFR05 | Nol hijau konflik; hijau dalam batas; transisi penuh. | Algoritma dan validasi diuji lulus. Perangkat/lokasi serta keseluruhan integrasi belum diterima. |
| NFR06 | Cadangan dalam satu tick setelah invalid, tanpa transisi terlewat. | Core dan browser lulus, termasuk snapshot stale/future, invalid rows, transisi beku serta cadangan/pemulihan. Ketepatan satu tick dibuktikan uji core. |
| NFR07 | Simulasi 30 menit tanpa kegagalan dan semua keputusan/transisi memiliki log terbaca. | Integrasi telemetri/controller/SQLite menyelesaikan 1800 detik dipercepat: 1800 snapshot, 32 keputusan dan 128 transisi terbaca kembali lengkap dalam JSON/CSV. Jalur visual 1800 detik dan ketahanan mesin/disk belum dibuktikan. Lihat `validation/reliability-check.json`. |

Benchmark nyata menggunakan Windows 11, Python 3.13.6, Torch 2.15.0 CPU empat thread, tanpa CUDA. Masukan benchmark adalah frame kosong sintetis 1280×720; terdapat 30 sampel setelah 3 warmup untuk profil 1280 dan 20 sampel untuk 640. Lihat `validation/backend-benchmark.json` dan `validation/backend-benchmark-640-threads4.json`. Tidak ada klaim akurasi dari frame kosong, gambar bus, atau video uji yang mengulang gambar publik.

## Target dampak dan protokol akhir

| ID | Target SRS | Status |
| --- | --- | --- |
| KPI01 | Rata-rata tunggu truth turun ≥10% terhadap baseline pada gabungan pasangan. | Belum diterima; perlu 15 pasangan visual dengan persepsi/simulator tervalidasi. |
| KPI02 | Antrean rata-rata berbobot waktu turun ≥10%; throughput minimal 95% baseline. | Perhitungan integral antrean/throughput tersedia dan diuji. Target dampak belum diterima. |
| KPI03 | Tidak ada fase terlewat; p95 tunggu setiap arah paling banyak 5% di atas baseline; batas giliran terpenuhi. | Audit urutan/batas 196 detik diuji; p95 per arah dan pemerataan pada 15 pasangan visual belum diterima. |

Evaluasi harus mencakup tiga tingkat arus × lima seed = 15 pasangan, 30 sesi. Setiap sesi 1800 detik, pemanasan 300 detik, pengukuran 1500 detik. Pasangan memakai geometri/rute/jadwal kedatangan/jenis kendaraan/kondisi awal/seed/transisi yang sama. Waktu tunggu semua kendaraan yang masuk jendela ukur termasuk yang belum keluar; antrean rata-rata berasal dari luas kurva dibagi jendela ukur. Baseline nol dilaporkan sebagai selisih absolut. Laporan harus memuat arah, pasangan, gabungan, variasi, sisa kendaraan, dan hasil gagal; gangguan diuji terpisah dari dampak nominal.

Kalibrasi baseline tersedia pada lima kandidat durasi × tiga arus × lima seed pengembangan 101–105 = 75 sesi, masing-masing 1800 detik/warmup 300. Seed uji 1–5 terpisah. Baseline dan source dikunci dengan checksum; perubahan source/konfigurasi mewajibkan kalibrasi ulang. Kalibrasi simulator prosedural ini belum menyatakan kecocokan baseline lapangan. Lihat `validation/baseline-development.json` dan `baseline-lock.json` untuk hasil dan identitas aktual setelah pembaruan terakhir.

Protokol anotasi memerlukan sedikitnya 300 pasangan ROI/timestamp, 60 lintasan, interval hitung keluar tetap, kondisi kosong/ringan/padat/motor/oklusi, dua penilai yang menyelesaikan perbedaan, serta pemisahan klip/periode kalibrasi dan uji. File `annotation-format.example.json` dan self-check evaluator adalah fixture, bukan dataset penerimaan.

Smoke visual terbaru menjalankan model nyata pada 24 frame, seluruhnya tanpa deteksi meskipun terdapat kendaraan acuan. Setiap sesi smoke berlangsung tiga detik dengan jam simulator berjalan independen dari inferensi; ini bukan uji ketahanan 30 menit. Renderer prosedural perlu diganti/dilatih/dikalibrasi dan divalidasi secara terukur; sistem tidak memasukkan telemetri tersembunyi untuk mengisi deteksi tersebut. Lima belas pasangan visual akhir dan klaim KPI menunggu perbaikan cakupan, data anotasi, dan performa perangkat.

## Sisa penerimaan

Kumpulkan video/ROI dan anotasi yang dikunci; kalibrasikan detektor/tracker/pengukuran serta peta konflik; validasikan simulator visual; penuhi benchmark 10 FPS/frame-ke-snapshot; kemudian jalankan 15 pasangan visual dan audit log serta seluruh target. Akses/retensi rekaman lapangan ditetapkan pemilik data. Tersedianya kode FR01–17 belum cukup untuk menyatakan seluruh SRS diterima.


## Bukti tambahan dari pengerjaan lanjutan

- [reliability-check.json](validation/reliability-check.json): integrasi 30 menit waktu simulasi dengan jurnal dibaca kembali; semua keputusan/transisi lengkap. Ini memakai jam dipercepat dan sensor telemetri.
- [paired-telemetry-calibrated.json](validation/paired-telemetry-calibrated.json): 15 pasangan referensi memakai baseline development yang sudah dikunci pada 20 detik, masing-masing 1800 detik dengan warmup 300. Antrean dan waktu tunggu adaptif justru lebih buruk pada model ini: tunggu gabungan 99,55 vs 86,59 detik (+14,97%); antrean 75,35 vs 64,52 kendaraan (+16,78%); throughput 2513,76 vs 2458,88 kendaraan/jam. Perhitungan ini tidak menerima KPI dan tidak menggantikan 15 pasangan visual.
- [backend-benchmark-onnx640-final.json](validation/backend-benchmark-onnx640-final.json): ONNX CPU pada masukan kosong 1280×720, inferensi 384×640, 30 frame setelah tiga warmup menghasilkan 7,54 FPS dan p95 observasi mentah 364 ms. Percobaan sebelumnya 8,75 FPS/173 ms disimpan terpisah. Keduanya di bawah 10 FPS dan belum mengukur akurasi maupun latensi snapshot browser.
- [real-inference-onnx-smoke.json](validation/real-inference-onnx-smoke.json): uji nyata juga lulus pada runtime ONNX. Tujuh belas uji backend dijalankan dan lulus pada masing-masing profil PyTorch dan ONNX; ini dua pelaksanaan suite yang sama, bukan 34 kasus berbeda.
- [visual-smoke.json](validation/visual-smoke.json): adaptif 3,45 FPS/p95 snapshot 1085 ms; tetap 3,99 FPS/1098 ms. Dua sesi tiga detik, seluruh deteksi kosong. NFR04 dan cakupan renderer gagal pada percobaan ini.

Default backend tetap PyTorch dan bobot `.pt`. ONNX adalah opsi eksperimen dengan ukuran inferensi berbeda yang memerlukan validasi ulang akurasi. Lima belas pasangan visual akhir belum dijalankan sebagai penerimaan karena cakupan detektor belum sah, performa belum memenuhi target dan anotasi terkunci belum tersedia.

## File source yang diubah atau ditambahkan

| Bagian | File |
| --- | --- |
| Backend dan penyimpanan | `backend/app.py`, `backend/storage.py`, `requirements.txt`, `requirements-onnx.txt` |
| Pengamatan dan kendali | `dist/core.js`, `dist/dashboard.js`, `dist/session-log.js`, `dist/visual-simulator.js` |
| Antarmuka | `dist/index.html`, `dist/style.css`, `dist/app.js` (entry kompatibilitas) |
| Uji dan evaluasi | `tests/core.test.mjs`, `tests/session.test.mjs`, `tests/visual.test.mjs`, `tests/test_backend.py`, `scripts/benchmark.py`, `scripts/browser-check.mjs`, `scripts/evaluate-visual.mjs`, `scripts/evaluate-annotations.mjs`, `scripts/experiment.mjs`, `scripts/reliability-check.mjs`, `scripts/make-test-video.py` |
| Dokumentasi dan bukti | `README.md`, `MVP_STATUS.md`, ekstraksi SRS, protokol, format anotasi, kalibrasi/lock serta laporan dalam `validation/` |


Persiapan model juga diuji: `/api/warmup` mencatat durasi dan metadata tanpa mengonsumsi timestamp/ID frame sumber; pemanasan ditolak setelah frame pertama dan kegagalan tidak dianggap siap. Browser diuji dari model dingin: startup 11,28 detik, frame pertama timestamp media 0,067 detik, 10 frame diproses dalam 3,34 detik aktif (3,00 FPS), p95 capture-ke-snapshot 667 ms. Ukuran 1280×720 menggunakan klip foto berulang; hasil pendek ini belum menerima NFR04 pada video representatif.


## Alur rekaman CCTV ke simulator pada versi 0.3

Sesuai pilihan pengguna 16 November, sumber operasional adalah berkas rekaman dan keluarannya adalah simulator. `dist/recorded-simulator.js` menjalankan kendaraan sintetis dengan objek controller yang sama dengan hasil pengamatan rekaman. Controller dipanggil satu kali tiap tick; sensor telemetri simulator tidak pernah diteruskan sebagai pengamatan pada mode ini. Uji browser menunggu keputusan adaptif dan pergantian fase, lalu memeriksa log keluaran pada fase hijau yang diputuskan.

Persiapan operator mencakup dimensi/durasi sumber, checksum worker, profil kamera durable, konfirmasi geometri setelah ganti sumber atau muat profil, dan tombol Mulai yang mengikuti status kesiapan. Pengaturan lanjutan dilipat agar profil dapat dipakai operator tanpa mengedit JSON setiap kali. `start.cmd` dan `scripts/start_local.py` memakai interpreter yang sama, memilih PyTorch/ONNX secara eksplisit dan menolak port yang sedang dipakai.

Pengamatan rekaman dan keluaran sintetis tetap terpisah dalam UI dan ekspor. `simulator_output`/`simulator_summary` memuat fase, gerak kendaraan serta metrik skenario sintetis; `track_measurement`/`snapshot` memuat pengamatan rekaman. Mode ini merupakan pengujian fungsional rekaman-ke-simulator, bukan evaluasi pengaruh lampu terhadap kendaraan di video dan belum menerima FR16/KPI visual tertutup.

Hasil browser terbaru pada ONNX: 101 frame / 15,69 detik aktif, 6,44 FPS, p95 capture-ke-snapshot 380 ms; input sumber 1280×720, input model tetap 384×640. Ini video foto publik berulang. NFR04 masih di bawah target FPS dan NFR01–03 tetap memerlukan anotasi persimpangan. Uji sembilan kelompok browser lulus tanpa error JavaScript, termasuk profil, keputusan adaptif, gerak simulator, jeda/lanjut tanpa error timestamp, EOF dan log.

Berkas baru/berubah pada tahap ini: `dist/recorded-simulator.js`, `dist/sha256.js`, `dist/hash-worker.js`, `dist/file-hash.js`, `dist/dashboard.js`, `dist/index.html`, `dist/style.css`, `backend/app.py`, `backend/storage.py`, `scripts/start_local.py`, `start.cmd`, `scripts/browser-check.mjs`, `scripts/check-file-worker.mjs`, `scripts/make-test-video.py`, `tests/recorded.test.mjs`, `tests/test_backend.py`, README dan laporan validasi.

Penerimaan CCTV lapangan masih memerlukan rekaman kamera yang dituju, kalibrasi ROI/garis/ambang serta anotasi. Jumlah ROI tetap empat. RTSP/USB, operasi tanpa tab dashboard aktif, ketahanan mesin/disk dan pengendali lampu fisik tidak dinyatakan tersedia pada alur yang dipilih ini.
