export const DIRS = ['Utara', 'Timur', 'Selatan', 'Barat'];
const EPS = 1e-9;
export const defaultFuzzy = () => ({
  queue: [[0, 0, 3, 8], [5, 15, 25], [18, 25, 30, 30]],
  wait: [[0, 0, 10, 30], [20, 60, 100], [80, 100, 120, 120]],
  green: [[10, 10, 15, 25], [20, 35, 50], [45, 55, 60, 60]],
  rules: [[0, 1, 2], [1, 1, 2], [2, 2, 2]], step: .1
});
const defaultPhases = () => DIRS.map((name, id) => ({id, name, rois: [id]}));
const defaultObservation = () => ({window: 1, enterSpeed: .01, exitSpeed: .02, enterSeconds: 1, exitSeconds: .5, missingSeconds: 1});
export const defaults = () => ({
  version: '0.2.0', gmin: 10, gmax: 60, fixed: 30, yellow: 3, allred: 1,
  seed: 42, level: 'sedang', warmup: 300, horizon: 1800,
  phases: defaultPhases(), phaseOrder: [0, 1, 2, 3],
  conflictMap: DIRS.map((_, i) => DIRS.map((__, j) => i !== j)),
  exitDirections: ['outward', 'outward', 'outward', 'outward'],
  observation: defaultObservation(), snapshotMaxAge: 2, recoverySnapshots: 3,
  fuzzy: defaultFuzzy(),
  vehicleClasses: [2, 3, 5, 7], confidence: .25, imgsz: 1280, roiLabels: [...DIRS],
  rois: [[[.34, .02], [.49, .02], [.49, .36], [.34, .36]], [[.64, .34], [.98, .34], [.98, .49], [.64, .49]], [[.51, .64], [.66, .64], [.66, .98], [.51, .98]], [[.02, .51], [.36, .51], [.36, .66], [.02, .66]]],
  exitLines: [[[.34, .36], [.49, .36]], [[.64, .34], [.64, .49]], [[.66, .64], [.51, .64]], [[.36, .66], [.36, .51]]]
});
export function configurationLocked(state) { return ['running', 'active', 'paused'].includes(state); }
export function phaseConfig(c) {
  const phases = c.phases ?? defaultPhases();
  return {phases, order: c.phaseOrder ?? phases.map((_, i) => i), conflicts: c.conflictMap ?? DIRS.map((_, i) => DIRS.map((__, j) => i !== j))};
}
export function phaseTiming(c, phase) {
  const p = phaseConfig(c).phases[phase];
  return {gmin: p.gmin ?? c.gmin, gmax: p.gmax ?? c.gmax, fixed: p.fixed ?? c.fixed, initial: p.initial ?? p.fixed ?? c.initial ?? c.fixed};
}
function point(p) { return Array.isArray(p) && p.length === 2 && p.every(x => Number.isFinite(x) && x >= 0 && x <= 1); }
const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
function onSegment(p, a, b) { return Math.abs(cross(a, b, p)) <= EPS && p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS && p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS; }
function segments(a, b, c, d, inclusive = false) {
  const ab1 = cross(a, b, c), ab2 = cross(a, b, d), cd1 = cross(c, d, a), cd2 = cross(c, d, b);
  return ab1 * ab2 < -EPS * EPS && cd1 * cd2 < -EPS * EPS || inclusive && (onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b));
}
export function inside(p, poly) {
  let b = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], c = poly[j];
    if (onSegment(p, a, c)) return true;
    if ((a[1] > p[1]) !== (c[1] > p[1]) && p[0] < (c[0] - a[0]) * (p[1] - a[1]) / (c[1] - a[1]) + a[0]) b = !b;
  }
  return b;
}
function overlap(a, b) { return a.some(p => inside(p, b)) || b.some(p => inside(p, a)) || a.some((p, i) => b.some((q, j) => segments(p, a[(i + 1) % a.length], q, b[(j + 1) % b.length], true))); }
function selfIntersects(poly) {
  return poly.some((a, i) => poly.some((b, j) => j > i && j !== (i + 1) % poly.length && i !== (j + 1) % poly.length && segments(a, poly[(i + 1) % poly.length], b, poly[(j + 1) % poly.length], true)));
}
function fuzzySettings(c) { return {...defaultFuzzy(), ...(c?.fuzzy ?? c ?? {})}; }
function validateFuzzy(c) {
  const f = fuzzySettings(c);
  const greenMin = c.gmin ?? 10, greenMax = c.gmax ?? 60;
  for (const [key, min, max] of [['queue', 0, 30], ['wait', 0, 120], ['green', greenMin, greenMax]]) {
    if (!Array.isArray(f[key]) || f[key].length !== 3) throw Error('Tiga himpunan fuzzy diperlukan per variabel.');
    for (const p of f[key]) if (!Array.isArray(p) || ![3, 4].includes(p.length) || p.some((x, i) => !Number.isFinite(x) || x < min || x > max || i > 0 && x < p[i - 1]) || p[0] === p.at(-1) || p.length === 3 && (p[0] === p[1] || p[1] === p[2])) throw Error('Parameter fungsi keanggotaan fuzzy tidak valid.');
    const ordered = [...f[key]].sort((a, b) => a[0] - b[0]);
    if (!ordered.some(p => mf(min, p) > 0) || !ordered.some(p => mf(max, p) > 0)) throw Error('Himpunan fuzzy harus menutupi seluruh domain.');
    let end = min;
    for (const p of ordered) {
      if (p[0] > end || p[0] === end && !ordered.some(other => mf(end, other) > 0)) throw Error('Himpunan fuzzy harus menutupi seluruh domain.');
      end = Math.max(end, p.at(-1));
    }
    if (end < max) throw Error('Himpunan fuzzy harus menutupi seluruh domain.');
  }
  if (!Array.isArray(f.rules) || f.rules.length !== 3 || f.rules.some(row => !Array.isArray(row) || row.length !== 3 || row.some(v => !Number.isInteger(v) || v < 0 || v > 2))) throw Error('Sembilan aturan fuzzy diperlukan.');
  if (!Number.isFinite(f.step) || f.step < .01 || f.step > 1 || Math.abs((greenMax - greenMin) / f.step - Math.round((greenMax - greenMin) / f.step)) > EPS || (greenMax - greenMin) / f.step > 100000) throw Error('Resolusi centroid harus membagi domain hijau.');
}
export function validate(c, options = {}) {
  if (options.locked || configurationLocked(options.sessionState)) throw Error('Konfigurasi dikunci selama sesi aktif atau jeda.');
  if (!c || typeof c !== 'object') throw Error('Konfigurasi harus berupa objek.');
  for (const k of ['gmin', 'gmax', 'fixed', 'yellow', 'allred']) if (!Number.isFinite(c[k]) || c[k] <= 0) throw Error('Durasi harus positif dan berupa angka.');
  if (c.gmin >= c.gmax) throw Error('Batas hijau terbalik atau tidak memiliki rentang.');
  if (c.fixed < c.gmin || c.fixed > c.gmax) throw Error('Hijau tetap harus berada dalam batas hijau.');
  if (c.initial !== undefined && (!Number.isFinite(c.initial) || c.initial < c.gmin || c.initial > c.gmax)) throw Error('Hijau awal harus berada dalam batas hijau.');
  if (!Number.isInteger(c.seed) || c.seed < 0) throw Error('Seed harus bilangan bulat nonnegatif.');
  if (!['ringan', 'sedang', 'padat'].includes(c.level)) throw Error('Tingkat arus tidak dikenal.');
  if (c.vehicleClasses !== undefined && (!Array.isArray(c.vehicleClasses) || !c.vehicleClasses.length || new Set(c.vehicleClasses).size !== c.vehicleClasses.length || c.vehicleClasses.some(v => !Number.isInteger(v) || v < 0))) throw Error('Kelas kendaraan harus daftar ID unik nonnegatif.');
  if (c.confidence !== undefined && (!Number.isFinite(c.confidence) || c.confidence <= 0 || c.confidence > 1)) throw Error('Confidence harus berada pada (0,1].');
  const sizes = Array.isArray(c.imgsz) ? c.imgsz : [c.imgsz ?? 1280];
  if (![1, 2].includes(sizes.length) || sizes.some(v => !Number.isInteger(v) || v < 32 || v > 2560 || v % 32)) throw Error('Ukuran inferensi harus kelipatan 32, maksimal 2560.');
  if (c.roiLabels !== undefined && (!Array.isArray(c.roiLabels) || c.roiLabels.length !== 4 || c.roiLabels.some(s => typeof s !== 'string' || !s.trim()))) throw Error('Empat label ROI diperlukan.');
  if (c.rois?.length !== 4 || c.exitLines?.length !== 4) throw Error('Empat ROI dan garis keluar diperlukan.');
  for (const p of c.rois) {
    if (!Array.isArray(p) || p.length < 3 || p.some(v => !point(v))) throw Error('ROI harus poligon dalam koordinat 0–1.');
    let area = 0;
    for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; if (Math.hypot(a[0] - b[0], a[1] - b[1]) < EPS) throw Error('Titik ROI berulang.'); area += a[0] * b[1] - b[0] * a[1]; }
    if (Math.abs(area) < .0001 || selfIntersects(p)) throw Error('Luas atau bentuk ROI tidak valid.');
  }
  for (const line of c.exitLines) if (!Array.isArray(line) || line.length !== 2 || line.some(p => !point(p)) || Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]) < .0001) throw Error('Garis keluar memerlukan dua titik berbeda dalam koordinat 0–1.');
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) if (overlap(c.rois[i], c.rois[j])) throw Error('ROI antrean bertumpang tindih.');
  if (c.exitDirections && (c.exitDirections.length !== 4 || c.exitDirections.some(d => !['outward', 'positive', 'negative'].includes(d)))) throw Error('Arah garis harus outward, positive, atau negative.');
  const {phases, order, conflicts} = phaseConfig(c);
  if (!Array.isArray(conflicts) || conflicts.length !== 4 || conflicts.some((r, i) => !Array.isArray(r) || r.length !== 4 || r.some((v, j) => typeof v !== 'boolean' || i === j && v || v !== conflicts[j]?.[i]))) throw Error('Peta konflik harus matriks simetris 4 × 4 dengan diagonal false.');
  if (!Array.isArray(phases) || !phases.length || phases.length > 16 || phases.some(p => !p || typeof p.name !== 'string' || !p.name.trim() || !Array.isArray(p.rois) || !p.rois.length || new Set(p.rois).size !== p.rois.length || p.rois.some(i => !Number.isInteger(i) || i < 0 || i > 3))) throw Error('Setiap fase memerlukan nama dan kelompok ROI yang valid.');
  if (new Set(phases.flatMap(p => p.rois)).size !== 4) throw Error('Semua ROI harus dilayani oleh urutan fase.');
  for (const p of phases) for (const i of p.rois) for (const j of p.rois) if (conflicts[i][j]) throw Error('Fase memuat gerakan yang berkonflik.');
  for (let i = 0; i < phases.length; i++) {
    const p = phaseTiming(c, i);
    if (Object.values(p).some(v => !Number.isFinite(v) || v <= 0) || p.gmin >= p.gmax || p.gmin < c.gmin || p.gmax > c.gmax || p.fixed < p.gmin || p.fixed > p.gmax || p.initial < p.gmin || p.initial > p.gmax) throw Error('Batas, hijau awal, atau cadangan per fase tidak valid.');
  }
  if (!Array.isArray(order) || order.length !== phases.length || new Set(order).size !== phases.length || order.some(i => !Number.isInteger(i) || i < 0 || i >= phases.length)) throw Error('Urutan harus memuat setiap fase tepat sekali.');
  const obs = {...defaultObservation(), ...c.observation};
  if (Object.values(obs).some(v => !Number.isFinite(v) || v <= 0) || obs.exitSpeed <= obs.enterSpeed || obs.missingSeconds > 10 || obs.window > 10 || obs.enterSeconds > 60 || obs.exitSeconds > 60) throw Error('Ambang pengamatan atau hysteresis tidak valid.');
  if (c.snapshotMaxAge !== undefined && (!Number.isFinite(c.snapshotMaxAge) || c.snapshotMaxAge <= 0 || c.snapshotMaxAge > 60)) throw Error('Batas usia snapshot tidak valid.');
  if (c.recoverySnapshots !== undefined && (!Number.isInteger(c.recoverySnapshots) || c.recoverySnapshots < 1 || c.recoverySnapshots > 100)) throw Error('Jumlah snapshot pemulihan tidak valid.');
  validateFuzzy(c);
  return c;
}
export function mf(x, p) {
  if (p.length === 3) { const [a, b, c] = p; return x === b ? 1 : x <= a || x >= c ? 0 : x < b ? (x - a) / (b - a) : (c - x) / (c - b); }
  const [a, b, c, d] = p;
  if (x < a || x > d) return 0;
  if (x >= b && x <= c) return 1;
  return x < b ? (x - a) / (b - a) : (d - x) / (d - c);
}
export function fuzzy(q, w, config) {
  if (!Number.isFinite(q) || !Number.isFinite(w) || q < 0 || w < 0) throw Error('Masukan fuzzy tidak valid');
  const Q = Math.min(q, 30), W = Math.min(w, 120), f = fuzzySettings(config), fires = [], gmin = config?.gmin ?? 10, gmax = config?.gmax ?? 60;
  let numerator = 0, area = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) fires.push({q: i, w: j, out: f.rules[i][j], strength: Math.min(mf(Q, f.queue[i]), mf(W, f.wait[j]))});
  const steps = Math.round((gmax - gmin) / f.step);
  for (let k = 0; k <= steps; k++) {
    const g = gmin + k * f.step, mu = Math.max(...fires.map(r => Math.min(r.strength, mf(g, f.green[r.out])))), weight = k === 0 || k === steps ? .5 : 1;
    area += mu * weight; numerator += g * mu * weight;
  }
  if (!(area > 0) || !Number.isFinite(numerator)) throw Error('Luas agregasi nol atau tidak valid');
  const centroid = numerator / area;
  return {rawQ: q, rawW: w, Q, W, centroid, green: Math.max(gmin, Math.min(gmax, Math.round(centroid * 10) / 10)), fires};
}
export function phaseRows(c, rows, phase) {
  const group = phaseConfig(c).phases[phase]?.rois ?? [], selected = group.map(i => rows?.[i]);
  const valid = selected.length > 0 && selected.every(r => r?.valid && Number.isFinite(r.q) && r.q >= 0 && Number.isFinite(r.w) && r.w >= 0);
  const vehicles = new Map();
  if (valid && selected.every(r => Array.isArray(r.vehicles))) for (const row of selected) for (const v of row.vehicles) vehicles.set(v.id, Math.max(vehicles.get(v.id) ?? 0, v.wait));
  const dedup = valid && selected.every(r => Array.isArray(r.vehicles)), q = valid ? dedup ? vehicles.size : selected.reduce((s, r) => s + r.q, 0) : null;
  return {phase, name: phaseConfig(c).phases[phase]?.name, q, w: valid ? dedup ? Math.max(0, ...vehicles.values()) : Math.max(...selected.map(r => r.w)) : null, avg: valid ? q ? dedup ? [...vehicles.values()].reduce((s, v) => s + v, 0) / q : selected.reduce((s, r) => s + (r.avg ?? 0) * r.q, 0) / q : 0 : null, valid, estimated: selected.some(r => r?.estimated), rois: [...group]};
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export class Controller {
  constructor(c, mode = 'adaptive') {
    validate(c); if (!['adaptive', 'fixed'].includes(mode)) throw Error('Mode pengendali tidak dikenal.');
    this.c = freeze(structuredClone(c)); this.mode = mode; this.time = 0;
    this.phase = phaseConfig(c).order[0]; this.state = 'HIJAU'; this.remaining = phaseTiming(c, this.phase).initial; this.duration = this.remaining;
    this.events = []; this.decisions = []; this.validStreak = 0; this.fallback = false; this.lastSnapshot = -Infinity; this.lastRecoverySnapshot = null; this.pending = null;
    this.redIntervals = []; this.lastGreenEnded = new Map(); this.fallbackSince = null;
  }
  get activeRois() { return [...phaseConfig(this.c).phases[this.phase].rois]; }
  get phaseName() { return phaseConfig(this.c).phases[this.phase].name; }
  get nextPhase() { const {order} = phaseConfig(this.c); return order[(order.indexOf(this.phase) + 1) % order.length]; }
  fresh(snapshot, time = this.time) { return !!(snapshot?.valid && phaseRows(this.c, snapshot.rows, this.nextPhase).valid && Number.isFinite(snapshot.time) && time - snapshot.time <= (this.c.snapshotMaxAge ?? 2) + EPS && time + EPS >= snapshot.time); }
  setFallback(value, reason, time = this.time) {
    if (this.mode === 'fixed' || value === this.fallback) return;
    this.fallback = value;
    if (value) { this.fallbackSince = time; this.events.push({time, type: 'gangguan', mode: 'cadangan', reason, fault_at: time}); }
    else { this.events.push({time, type: 'pemulihan', mode: 'adaptif', reason, fault_at: this.fallbackSince, recovered_at: time}); this.fallbackSince = null; }
  }
  get diagnostics() {
    const {phases, order} = phaseConfig(this.c), transition = this.c.yellow + this.c.allred;
    const bounds = phases.map((_, i) => phases.reduce((s, __, j) => s + (i === j ? 0 : phaseTiming(this.c, j).gmax), 0) + order.length * transition);
    return {maxRedSeconds: Math.max(0, ...this.redIntervals.map(v => v.seconds)), boundSeconds: Math.max(...bounds), redBoundViolations: this.redIntervals.filter(v => v.seconds > bounds[v.phase] + EPS), phaseOrder: [...order]};
  }
  tick(dt, snapshot) {
    if (!Number.isFinite(dt) || dt <= 0) throw Error('Langkah waktu harus positif.');
    const target = this.time + dt, fresh = this.fresh(snapshot, target);
    if (!fresh) { this.setFallback(true, snapshot?.reason ?? 'sumber atau snapshot tidak valid/kedaluwarsa', this.time); this.validStreak = 0; this.lastRecoverySnapshot = null; }
    else if (snapshot.time > this.lastSnapshot + EPS) {
      this.lastSnapshot = snapshot.time;
      const published = Number.isFinite(snapshot.published_at) && snapshot.published_at >= snapshot.time - EPS && snapshot.published_at <= target + EPS ? snapshot.published_at : snapshot.time;
      if (this.lastRecoverySnapshot === null || published - this.lastRecoverySnapshot > 1.1 + EPS) { this.validStreak = 1; this.lastRecoverySnapshot = published; }
      else if (published - this.lastRecoverySnapshot >= 1 - EPS) { this.validStreak++; this.lastRecoverySnapshot = published; }
    }
    let left = dt;
    while (left > EPS) {
      const step = Math.min(left, this.remaining); this.time += step; this.remaining -= step; left -= step;
      if (this.remaining > EPS) continue;
      if (this.state === 'HIJAU') {
        const next = this.nextPhase, row = phaseRows(this.c, snapshot?.rows, next);
        let reason = null, decision = null;
        if (this.mode === 'fixed') reason = 'baseline tetap';
        else if (!this.fresh(snapshot) || !row.valid) reason = 'sumber atau snapshot tidak valid';
        else if (this.validStreak < (this.c.recoverySnapshots ?? 3)) reason = `menunggu ${this.c.recoverySnapshots ?? 3} snapshot pemulihan`;
        else { try { decision = fuzzy(row.q, row.w, this.c); } catch (e) { reason = e.message; } }
        this.setFallback(!decision, reason ?? 'tiga snapshot valid berinterval satu detik', this.time);
        const timing = phaseTiming(this.c, next), finalGreen = decision ? Math.max(timing.gmin, Math.min(timing.gmax, Math.round(Math.max(timing.gmin, Math.min(timing.gmax, decision.centroid)) * 10) / 10)) : timing.fixed;
        if (decision) decision.green = finalGreen;
        this.pending = freeze({time: this.time, from: this.phase, to: next, phase_name: phaseConfig(this.c).phases[next].name, rois: row.rois, q: row.q, w: row.w, avg: row.avg, snapshot_time: snapshot?.time ?? null, snapshot_age: snapshot ? this.time - snapshot.time : null, green: finalGreen, bounds: [timing.gmin, timing.gmax], centroid: decision?.centroid ?? null, mode: decision ? 'adaptif' : this.mode === 'fixed' ? 'tetap' : 'cadangan', reason, fallback_since: this.fallbackSince, detail: decision});
        this.lastGreenEnded.set(this.phase, this.time);
        this.decisions.push(this.pending); this.state = 'KUNING'; this.remaining = this.c.yellow;
      } else if (this.state === 'KUNING') { this.state = 'SEMUA MERAH'; this.remaining = this.c.allred; }
      else {
        this.phase = this.pending.to; this.state = 'HIJAU'; this.duration = this.pending.green; this.remaining = this.duration;
        if (this.lastGreenEnded.has(this.phase)) this.redIntervals.push({phase: this.phase, start: this.lastGreenEnded.get(this.phase), end: this.time, seconds: this.time - this.lastGreenEnded.get(this.phase)});
        this.events.push({...this.pending, time: this.time, type: 'keputusan_berlaku', decision_at: this.pending.time, applied_at: this.time});
      }
      this.events.push({time: this.time, state: this.state, phase: this.phase, rois: this.activeRois, duration: this.remaining});
    }
    this.time = target;
    return this;
  }
}
export function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return (s + .5) / 4294967296; }; }
export function schedule(c, horizon = 1800) { const random = rng(c.seed), base = {ringan: .08, sedang: .18, padat: .3}[c.level] ?? .18, items = []; for (let dir = 0; dir < 4; dir++) { let t = 0, rate = base * [1.5, .7, 1.1, .6][dir]; while ((t += -Math.log(random()) / rate) < horizon) items.push({at: t, dir}); } return items.sort((a, b) => a.at - b.at); }
export class Simulation {
  constructor(c, mode = 'adaptive', arrivals = null) { this.c = structuredClone(c); this.controller = new Controller(c, mode); this.arrivals = arrivals ?? schedule(c, 7200); this.index = 0; this.time = 0; this.nextId = 1; this.cars = []; this.departed = []; this.snapshot = null; this.snapshots = []; this.history = []; this.area = 0; this.queueIntervals = []; this.rows = DIRS.map(() => ({q: 0, w: 0, avg: 0, valid: true})); }
  tick(dt = .1, healthy = true) {
    this.time = Math.round((this.time + dt) * 1e6) / 1e6;
    while (this.index < this.arrivals.length && this.arrivals[this.index].at <= this.time) { const a = this.arrivals[this.index++], tail = this.cars.filter(car => car.dir === a.dir).reduce((max, car) => Math.max(max, car.pos), -Infinity); this.cars.push({id: this.nextId++, dir: a.dir, pos: Math.max(1.2, tail + .085), wait: 0, arrival: a.at, departed: null}); }
    for (let dir = 0; dir < 4; dir++) {
      const lane = this.cars.filter(c => c.dir === dir).sort((a, b) => a.pos - b.pos); let front = -2;
      for (const car of lane) { const old = car.pos, green = this.controller.state === 'HIJAU' && this.controller.activeRois.includes(dir), target = green ? -1 : .03, next = Math.max(target, front + .085, old - dt * .13); car.pos = Math.min(old, next); car.queued = car.pos >= 0 && old - car.pos < dt * .005; if (car.queued) car.wait += dt; front = car.pos; if (car.pos < -.8) { car.departed = this.time; this.departed.push(car); } }
    }
    this.cars = this.cars.filter(c => c.departed === null);
    this.rows = DIRS.map((_, dir) => { const cars = this.cars.filter(c => c.dir === dir && c.queued && c.pos >= 0); return {q: cars.length, w: Math.max(0, ...cars.map(c => c.wait)), avg: cars.length ? cars.reduce((s, c) => s + c.wait, 0) / cars.length : 0, valid: healthy}; });
    this.queueIntervals.push({start: this.time - dt, end: this.time, q: this.rows.map(r => r.q)});
    if (!this.snapshot || this.time - this.snapshot.time >= .999) { this.snapshot = {time: this.time, valid: healthy, rows: structuredClone(this.rows)}; this.snapshots.push(this.snapshot); this.history.push({time: this.time, q: this.rows.reduce((s, r) => s + r.q, 0), w: Math.max(...this.rows.map(r => r.w))}); }
    if (!healthy) this.snapshot = {...this.snapshot, valid: false};
    this.controller.tick(dt, this.snapshot); return this;
  }
  metrics(warmup = 0) {
    const all = [...this.cars, ...this.departed].filter(c => c.arrival >= warmup), measurementSeconds = Math.max(0, this.time - warmup), duration = measurementSeconds || 1, queueAreaByDirection = [0, 0, 0, 0];
    for (const interval of this.queueIntervals) { const dt = Math.max(0, Math.min(this.time, interval.end) - Math.max(warmup, interval.start)); for (let dir = 0; dir < 4; dir++) queueAreaByDirection[dir] += interval.q[dir] * dt; }
    const per = DIRS.map((name, dir) => { const a = all.filter(c => c.dir === dir), w = a.map(c => c.wait).sort((a, b) => a - b), waitSum = w.reduce((s, v) => s + v, 0); return {name, entered: a.length, remaining: a.filter(c => c.departed === null).length, waitSum, waitSamples: w, meanWait: a.length ? waitSum / a.length : 0, p95: w.length ? w[Math.ceil(.95 * w.length) - 1] : 0, meanQueue: queueAreaByDirection[dir] / duration}; });
    const queueArea = queueAreaByDirection.reduce((s, v) => s + v, 0);
    const waitSum = all.reduce((s, c) => s + c.wait, 0), throughputCount = this.departed.filter(c => c.departed >= warmup).length;
    return {meanWait: all.length ? waitSum / all.length : 0, waitSum, meanQueue: queueArea / duration, queueArea, queueAreaByDirection, measurementSeconds, throughputCount, throughput: throughputCount * 3600 / duration, remaining: this.cars.length, entered: all.length, perDirection: per, control: this.controller.diagnostics};
  }
}
export function paired(c, horizon = c.horizon ?? 1800) { const arrivals = schedule(c, horizon), a = new Simulation(c, 'adaptive', arrivals), b = new Simulation(c, 'fixed', arrivals); for (let t = 0; t < Math.round(horizon * 10); t++) { a.tick(); b.tick(); } const adaptive = a.metrics(c.warmup ?? 300), fixed = b.metrics(c.warmup ?? 300), pct = k => fixed[k] === 0 ? null : 100 * (fixed[k] - adaptive[k]) / fixed[k]; return {scenario: {seed: c.seed, level: c.level, horizon, warmup: c.warmup, arrivals: arrivals.length, source: 'simulator telemetry; not visual inference', config: structuredClone(c)}, adaptive, fixed, improvement: {wait: pct('meanWait'), queue: pct('meanQueue')}, throughputRatio: fixed.throughput ? adaptive.throughput / fixed.throughput : null, decisions: a.controller.decisions, history: {adaptive: a.history, fixed: b.history}}; }
export class Observer {
  constructor(c) { validate(c); this.c = freeze(structuredClone(c)); this.options = {...defaultObservation(), ...c.observation}; this.tracks = new Map(); this.archive = new Map(); this.served = new Set(); this.counts = [0, 0, 0, 0]; this.lastTime = -1; }
  retire(v, reason, time) { this.archive.set(v.id, {id: v.id, roi: v.roi, wait: v.wait, last: v.last, ended_at: time, incomplete: !this.served.has(`${v.roi}:${v.id}`), reason}); this.tracks.delete(v.id); }
  update(time, detections, options = {}) {
    if (!Number.isFinite(time) || time < 0 || time <= this.lastTime) throw Error('Timestamp media harus meningkat');
    if (!Array.isArray(detections)) throw Error('Deteksi harus berupa array; array kosong berarti jalan teramati kosong.');
    this.lastTime = time; const valid = options.valid !== false, active = new Set(), cfg = this.options;
    if (valid) for (const d of detections) {
      if (d.class_id !== undefined && !(this.c.vehicleClasses ?? [2, 3, 5, 7]).includes(d.class_id)) continue;
      if (d.id == null || !['number', 'string'].includes(typeof d.id) || typeof d.id === 'number' && !Number.isFinite(d.id) || !Array.isArray(d.box) || d.box.length !== 4 || d.box.some(x => !Number.isFinite(x) || x < 0 || x > 1) || d.box[0] >= d.box[2] || d.box[1] >= d.box[3] || active.has(d.id)) continue;
      const id = d.id, p = [(d.box[0] + d.box[2]) / 2, d.box[3]], roi = this.c.rois.findIndex(poly => inside(p, poly));
      let v = this.tracks.get(id); active.add(id);
      if (v && time - v.last > cfg.missingSeconds + EPS) { this.retire(v, 'track hilang melewati toleransi', time); v = null; }
      if (v && !v.missing && !this.served.has(`${v.roi}:${id}`)) {
        const [a, b] = this.c.exitLines[v.roi], oldSide = v.lineSide, newSide = cross(a, b, p), direction = this.c.exitDirections?.[v.roi] ?? 'outward';
        const poly = this.c.rois[v.roi], center = poly.reduce((r, x) => [r[0] + x[0] / poly.length, r[1] + x[1] / poly.length], [0, 0]), insideSide = cross(a, b, center);
        const desired = direction === 'positive' ? 1 : direction === 'negative' ? -1 : -Math.sign(insideSide);
        if (Math.abs(newSide) > EPS && oldSide * desired < -EPS && newSide * desired > EPS && segments(v.p, p, a, b, true)) { this.served.add(`${v.roi}:${id}`); this.counts[v.roi]++; }
      }
      if (roi < 0) { if (v) this.retire(v, 'keluar ROI', time); continue; }
      if (v && v.roi !== roi) { this.retire(v, 'berpindah ROI', time); v = null; }
      if (!v) v = {id, roi, wait: this.archive.get(id)?.wait ?? 0, queued: false, history: [], last: time, confirm: null, moving: null, lineSide: 0};
      this.archive.delete(id);
      const gap = time - v.last, observedInterval = gap <= cfg.missingSeconds + EPS && !v.missing;
      if (v.missing) { v.history = []; v.confirm = null; v.moving = null; }
      if (v.queued && observedInterval) v.wait += gap;
      v.history.push({time, p}); v.history = v.history.filter(h => time - h.time <= cfg.window + Math.max(gap, .1) + EPS);
      const ref = [...v.history].reverse().find(h => time - h.time >= cfg.window - EPS), poly = this.c.rois[roi], height = Math.max(...poly.map(x => x[1])) - Math.min(...poly.map(x => x[1]));
      if (ref) {
        const speed = Math.hypot(p[0] - ref.p[0], p[1] - ref.p[1]) / (time - ref.time) / height;
        if (speed <= cfg.enterSpeed + EPS) {
          v.confirm ??= ref.time;
          if (!v.queued && time - v.confirm >= cfg.enterSeconds - EPS) { v.queued = true; v.wait += time - v.confirm; }
          v.moving = null;
        } else {
          v.confirm = null;
          if (v.queued && speed > cfg.exitSpeed) { v.moving ??= time; if (time - v.moving >= cfg.exitSeconds - EPS) { v.queued = false; v.moving = null; } }
          else v.moving = null;
        }
      }
      const [a, b] = this.c.exitLines[roi], side = cross(a, b, p);
      if (Math.abs(side) > EPS) v.lineSide = side;
      v.p = p; v.last = time; v.missing = false; this.tracks.set(id, v);
    }
    for (const [id, v] of this.tracks) { if (time - v.last > cfg.missingSeconds + EPS) this.retire(v, 'track hilang melewati toleransi', time); else if (!active.has(id)) v.missing = true; }
    const rows = DIRS.map((name, roi) => { const a = [...this.tracks.values()].filter(v => v.roi === roi && v.queued); return {roi, name: this.c.roiLabels?.[roi] ?? name, time, age: 0, q: valid ? a.length : null, w: valid ? Math.max(0, ...a.map(v => v.wait)) : null, avg: valid ? a.length ? a.reduce((s, v) => s + v.wait, 0) / a.length : 0 : null, estimated: a.some(v => !active.has(v.id)), valid, reason: valid ? null : options.reason ?? 'frame tidak valid', vehicles: valid ? a.map(v => ({id: v.id, wait: v.wait})) : []}; });
    return {time, media_time: time, age: 0, source_id: options.sourceId ?? null, frame_id: options.frameId ?? null, valid, reason: valid ? null : options.reason ?? 'frame tidak valid', rows, phases: phaseConfig(this.c).phases.map((_, i) => ({...phaseRows(this.c, rows, i), time, age: 0})), tracks: [...this.tracks.values()].map(v => ({id: v.id, roi: v.roi, point: [...v.p], wait: v.wait, queued: v.queued, estimated: !active.has(v.id)})), served: [...this.counts], served_estimated: true};
  }
  invalidate(time, reason = 'frame tidak valid') { return this.update(time, [], {valid: false, reason}); }
  finish() { return {served: [...this.counts], served_estimated: true, incomplete_tracks: [...this.archive.values(), ...[...this.tracks.values()].map(v => ({id: v.id, roi: v.roi, wait: v.wait, last: v.last, incomplete: !this.served.has(`${v.roi}:${v.id}`), reason: 'akhir sesi'}))].filter(v => v.incomplete)}; }
}
