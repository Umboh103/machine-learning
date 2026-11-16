import test from 'node:test';import assert from 'node:assert/strict';import{defaults,validate,fuzzy,Controller,Simulation,Observer,schedule,paired,configurationLocked,phaseRows}from'../dist/core.js';
const healthy=t=>({time:t,valid:true,rows:Array.from({length:4},()=>({q:10,w:20,valid:true}))});
test('Mamdani covers entire domain and clamps high inputs',()=>{for(let q=0;q<=30;q++)for(let w=0;w<=120;w+=2){let x=fuzzy(q,w);assert.ok(x.green>=10&&x.green<=60);assert.ok(Number.isFinite(x.centroid));}assert.deepEqual(fuzzy(100,300).green,fuzzy(30,120).green);assert.ok(fuzzy(30,120).green>fuzzy(0,0).green);assert.throws(()=>fuzzy(NaN,0));});
test('four phases preserve sequence, yellow and all-red; freeze pending decision',()=>{let c=new Controller(defaults()),changes=[],previous=c.state;for(let i=1;i<=3000;i++){c.tick(.1,healthy(i*.1));if(c.state!==previous){changes.push({state:c.state,time:c.time,phase:c.phase});previous=c.state;}}for(let i=0;i<changes.length-2;i+=3){assert.equal(changes[i].state,'KUNING');assert.equal(changes[i+1].state,'SEMUA MERAH');assert.equal(changes[i+2].state,'HIJAU');assert.ok(Math.abs(changes[i+1].time-changes[i].time-3)<1e-6);assert.ok(Math.abs(changes[i+2].time-changes[i+1].time-1)<1e-6);assert.equal(changes[i+2].phase,(changes[i].phase+1)%4);}assert.ok(c.decisions.every(d=>d.green>=10&&d.green<=60));});
test('fault flags fallback promptly, green completes; three snapshots restore decisions',()=>{let c=new Controller(defaults());c.tick(.1,null);assert.equal(c.fallback,true);assert.equal(c.state,'HIJAU');assert.ok(c.remaining>29);for(let i=1;i<300;i++)c.tick(.1,null);assert.equal(c.state,'KUNING');assert.equal(c.pending.mode,'cadangan');let g=c.pending.green;for(let i=0;i<40;i++)c.tick(.1,healthy(c.time+.1));assert.equal(c.state,'HIJAU');assert.equal(c.duration,g);for(let i=0;i<300;i++)c.tick(.1,healthy(c.time+.1));assert.equal(c.pending.mode,'adaptif');});
test('seeded arrival schedule reproducible and shared; paired finite and deterministic',()=>{let c=defaults();assert.deepEqual(schedule(c,300),schedule(c,300));let a=paired({...c,warmup:10},100),b=paired({...c,warmup:10},100);assert.deepEqual(a,b);assert.ok(Number.isFinite(a.adaptive.meanWait));assert.equal(a.adaptive.entered,a.fixed.entered);});
test('observation counts stationary IDs once, expiry and no missing-time accumulation',()=>{let o=new Observer(defaults()),det={id:1,box:[.38,.15,.4,.2]},s;for(let t=0;t<=2;t+=.25)s=o.update(t,[det]);assert.equal(s.rows[0].q,1);assert.equal(s.rows[0].w,2);s=o.update(2.5,[]);assert.equal(s.rows[0].q,1);assert.equal(s.rows[0].w,2);assert.equal(s.rows[0].estimated,true);s=o.update(3.25,[]);assert.equal(s.rows[0].q,0);s=o.update(3.5,[{...det,id:2}]);assert.equal(s.rows[0].w,0);assert.throws(()=>o.update(3.5,[det]));});
test('exit crossing increments once per ID',()=>{let o=new Observer(defaults());o.update(0,[{id:8,box:[.38,.3,.4,.35]}]);o.update(.25,[{id:8,box:[.38,.34,.4,.38]}]);assert.equal(o.counts[0],1);o.update(.5,[{id:8,box:[.38,.34,.4,.38]}]);assert.equal(o.counts[0],1);});
test('rejects malformed, overlapping ROI and unsafe durations',()=>{assert.throws(()=>validate({...defaults(),fixed:70}));assert.throws(()=>validate({...defaults(),yellow:-1}));let c=defaults();c.rois[1]=c.rois[0];assert.throws(()=>validate(c));});
test('simulation completes 30min with valid bounds and arrivals respond to signals',()=>{let c=defaults(),s=new Simulation(c);for(let i=0;i<18000;i++)s.tick();assert.ok(s.departed.length>0);assert.ok(s.controller.decisions.length>30);assert.ok(s.controller.decisions.every(d=>d.green>=10&&d.green<=60));assert.ok(s.cars.every(v=>v.wait>=0));});
test('reappearance after observed missing frame does not accumulate the unobserved gap',()=>{let o=new Observer(defaults()),d={id:1,box:[.38,.15,.4,.2]},s;for(let t=0;t<=2;t+=.25)s=o.update(t,[d]);o.update(2.25,[]);s=o.update(2.5,[d]);assert.equal(s.rows[0].w,2);});

const north = (id, bottom = .2) => ({id, class_id: 2, box: [.38, bottom - .04, .4, bottom]});
function groupedConfig() {
  const c = defaults();
  c.phases = [{id: 'ns', name: 'Utara Selatan', rois: [0, 2]}, {id: 'ew', name: 'Timur Barat', rois: [1, 3]}];
  c.phaseOrder = [1, 0];
  c.conflictMap[0][2] = c.conflictMap[2][0] = false;
  c.conflictMap[1][3] = c.conflictMap[3][1] = false;
  return c;
}
test('phase groups follow configured order and use sum Q and max W for the NEXT phase', () => {
  const config = groupedConfig(), c = new Controller(config);
  const rows = [{q: 2, w: 11, valid: true}, {q: 7, w: 99, valid: true}, {q: 3, w: 42, valid: true}, {q: 8, w: 100, valid: true}];
  assert.equal(c.phaseName, 'Timur Barat'); assert.deepEqual(c.activeRois, [1, 3]); assert.equal(c.nextPhase, 0);
  for (let i = 1; i <= 300; i++) c.tick(.1, {time: i / 10, valid: true, rows});
  assert.equal(c.state, 'KUNING'); assert.equal(c.phase, 1);
  assert.equal(c.pending.to, 0); assert.equal(c.pending.q, 5); assert.equal(c.pending.w, 42);
  assert.equal(c.pending.green, fuzzy(5, 42).green); assert.deepEqual(c.pending.rois, [0, 2]);
  c.tick(4, {time: 34, valid: true, rows});
  assert.deepEqual(c.activeRois, [0, 2]); assert.equal(c.nextPhase, 1);
  assert.equal(phaseRows(config, rows, 1).q, 15);
  rows[2].valid = false; assert.equal(phaseRows(config, rows, 0).valid, false);
});
test('conflicting phase groups, asymmetric conflicts and incomplete phase orders are rejected', () => {
  let c = groupedConfig(); c.conflictMap[0][2] = c.conflictMap[2][0] = true; assert.throws(() => validate(c), /berkonflik/);
  c = groupedConfig(); c.conflictMap[0][1] = false; assert.throws(() => validate(c), /simetris/);
  c = groupedConfig(); c.phaseOrder = [1, 1]; assert.throws(() => validate(c), /Urutan/);
  c = groupedConfig(); c.phases[0].rois = [0]; assert.throws(() => validate(c), /Semua ROI/);
});
test('large time steps retain full yellow and all-red boundaries without skipping phases', () => {
  const c = new Controller(defaults(), 'fixed'); c.tick(36, null);
  assert.equal(c.phase, 1); assert.equal(c.state, 'HIJAU'); assert.equal(c.remaining, 28);
  assert.deepEqual(c.events.filter(e => e.state).map(e => [e.time, e.state]), [[30, 'KUNING'], [33, 'SEMUA MERAH'], [34, 'HIJAU']]);
  assert.equal(c.events.find(e => e.type === 'keputusan_berlaku').decision_at, 30);
  assert.throws(() => c.tick(0, null)); assert.throws(() => c.tick(NaN, null));
});
test('a frozen pending decision survives fault during transition; source cannot edit active configuration', () => {
  const config = defaults(), c = new Controller(config);
  for (let i = 1; i <= 300; i++) c.tick(.1, healthy(i / 10));
  const chosen = c.pending.green;
  config.fixed = 60; config.phases[1].rois = [0];
  assert.equal(c.c.fixed, 30); assert.deepEqual(c.c.phases[1].rois, [1]);
  assert.throws(() => { c.c.fixed = 10; }, TypeError);
  assert.throws(() => { c.pending.green = 60; }, TypeError);
  c.tick(4, null); assert.equal(c.duration, chosen); assert.equal(c.fallback, true);
  assert.equal(configurationLocked('paused'), true);
  assert.throws(() => validate(defaults(), {sessionState: 'running'}), /dikunci/);
  assert.throws(() => validate(defaults(), {sessionState: 'paused'}), /dikunci/);
  assert.doesNotThrow(() => validate(defaults(), {sessionState: 'ended'}));
});
test('repeating one fresh snapshot cannot recover fallback; malformed rows and stale data are faults', () => {
  const c = new Controller({...defaults(), fixed: 10}); c.tick(.1, null);
  const snapshot = healthy(9.6); c.tick(9.5, snapshot);
  for (let i = 0; i < 4; i++) c.tick(.1, snapshot);
  assert.equal(c.pending.mode, 'cadangan'); assert.match(c.pending.reason, /pemulihan/);
  c.tick(.1, healthy(10.1)); c.tick(.1, healthy(10.2));
  const malformed = healthy(10.3); malformed.rows[1].q = NaN; c.tick(.1, malformed);
  assert.equal(c.fallback, true); assert.equal(c.validStreak, 0);
  c.tick(3, healthy(10.3)); assert.equal(c.validStreak, 0);
});
test('valid empty road differs from invalid perception and missing gaps never accrue waiting time', () => {
  const o = new Observer(defaults());
  let s = o.update(0, []); assert.equal(s.valid, true); assert.equal(s.rows[0].q, 0); assert.equal(s.rows[0].w, 0);
  for (let t = .25; t <= 2.25; t += .25) s = o.update(t, [north(1)]);
  assert.equal(s.rows[0].w, 2);
  s = o.invalidate(2.5, 'decoder gagal'); assert.equal(s.valid, false); assert.equal(s.rows[0].q, null); assert.equal(s.reason, 'decoder gagal');
  s = o.update(2.75, [north(1)]); assert.equal(s.rows[0].w, 2);
  s = o.update(3, [north(1)]); assert.equal(s.rows[0].w, 2.25);
  s = o.update(4.1, []); assert.equal(s.rows[0].q, 0); assert.equal(o.tracks.size, 0);
});
test('media time measures observed durations independently of file offset and frame resize', () => {
  const o = new Observer(defaults());
  o.update(100, [north(1)]); let s = o.update(101, [north(1)], {frameId: 2});
  assert.equal(s.media_time, 101); assert.equal(s.frame_id, 2); assert.equal(s.rows[0].w, 1);
  assert.deepEqual(s.tracks[0].point, [.39, .2]);
  assert.throws(() => o.update(100.5, [north(1)]), /Timestamp media/);
  assert.throws(() => o.update(101.5, null), /array/);
  s = o.update(101.5, [north(1)]); assert.equal(s.rows[0].w, 1.5);
});
test('queue hysteresis tolerates brief motion and confirms sustained departure', () => {
  const o = new Observer(defaults()); let s;
  for (let t = 0; t <= 2; t += .25) s = o.update(t, [north(1)]);
  assert.equal(s.rows[0].q, 1);
  s = o.update(2.25, [north(1, .21)]); assert.equal(s.rows[0].q, 1);
  s = o.update(2.5, [north(1, .22)]); assert.equal(s.rows[0].q, 1);
  s = o.update(2.75, [north(1, .23)]); assert.equal(s.rows[0].q, 0);
  assert.equal(s.tracks[0].wait, 2.75);
});
test('directed exit accepts line contact and counts once per ID and direction', () => {
  const o = new Observer(defaults());
  o.update(0, [north(8, .35)]); o.update(.1, [north(8, .36)]); o.update(.2, [north(8, .38)]);
  assert.equal(o.counts[0], 1);
  o.update(.3, [north(8, .35)]); o.update(.4, [north(8, .38)]); assert.equal(o.counts[0], 1);
  const reverse = new Observer(defaults());
  reverse.update(0, [north(9, .38)]); reverse.update(.1, [north(9, .35)]); assert.equal(reverse.counts[0], 0);
});
test('explicit positive/negative exit directions and missing tracks prevent false crossing', () => {
  const c = defaults(); c.exitLines[0] = [[.34, .25], [.49, .25]];
  c.exitDirections[0] = 'negative'; const negative = new Observer(c);
  negative.update(0, [north(1, .2)]); negative.update(.25, [north(1, .3)]); assert.equal(negative.counts[0], 0);
  negative.update(.5, [north(1, .2)]); assert.equal(negative.counts[0], 1);
  c.exitDirections[0] = 'positive'; const positive = new Observer(c);
  positive.update(0, [north(1, .2)]); positive.update(.25, [north(1, .3)]); assert.equal(positive.counts[0], 1);
  const missing = new Observer(c); missing.update(0, [north(2, .2)]); missing.update(.1, []); missing.update(.2, [north(2, .3)]); assert.equal(missing.counts[0], 0);
});
test('duplicate detections and nonvehicle classes do not inflate queues; expired tracks are released', () => {
  const o = new Observer(defaults()); let s;
  for (let t = 0; t <= 2; t += .25) s = o.update(t, [north(1), north(1), {...north(2), class_id: 0}]);
  assert.equal(s.rows[0].q, 1); assert.equal(s.tracks.length, 1);
  for (let i = 21; i <= 500; i++) o.update(i / 10, [north(i)]);
  assert.ok(o.tracks.size <= 11); o.update(52, []); assert.equal(o.tracks.size, 0);
});
test('self-intersecting ROI and uncovered fuzzy domains are rejected; configured rules affect green', () => {
  let c = defaults(); c.rois[0] = [[.34, .02], [.49, .36], [.34, .36], [.49, .02]]; assert.throws(() => validate(c), /ROI/);
  c = defaults(); c.fuzzy.queue[0] = [1, 1, 3, 8]; assert.throws(() => validate(c), /domain/);
  c = defaults(); c.fuzzy.rules[0][0] = 2; validate(c); assert.ok(fuzzy(0, 0, c).green > fuzzy(0, 0).green);
  c.fuzzy.rules[0][0] = 4; assert.throws(() => validate(c), /aturan/);
});
test('simultaneous grouped green serves both allowed directions and incoming vehicles retain spacing', () => {
  const c = groupedConfig(), s = new Simulation(c, 'fixed', [{at: .1, dir: 1}, {at: .1, dir: 1}, {at: .1, dir: 3}]);
  s.tick(); const lane = s.cars.filter(v => v.dir === 1).sort((a, b) => a.pos - b.pos);
  assert.ok(lane[1].pos - lane[0].pos >= .085 - 1e-9);
  for (let i = 0; i < 170; i++) s.tick();
  assert.equal(s.departed.filter(v => v.dir === 1).length, 2); assert.equal(s.departed.filter(v => v.dir === 3).length, 1);
});
test('AT06 maximum red-to-return interval is 196 seconds on the four-phase profile', () => {
  const c = new Controller({...defaults(), fixed: 60}, 'fixed'); c.tick(600, null);
  assert.equal(c.diagnostics.boundSeconds, 196); assert.equal(c.diagnostics.maxRedSeconds, 196);
  assert.equal(c.diagnostics.redBoundViolations.length, 0);
  assert.deepEqual(c.redIntervals.slice(0, 4).map(v => v.phase), [0, 1, 2, 3]);
});
test('per-phase initial, fallback and adaptive durations respect phase bounds', () => {
  const config = defaults(); config.phases[0].initial = 12; config.phases[1] = {...config.phases[1], gmin: 40, gmax: 50, fixed: 45};
  const fallback = new Controller(config); assert.equal(fallback.remaining, 12);
  fallback.tick(12, null); assert.equal(fallback.pending.green, 45); fallback.tick(4, null); assert.equal(fallback.duration, 45);
  const adaptive = new Controller(config);
  for (let i = 1; i <= 120; i++) adaptive.tick(.1, {time: i / 10, valid: true, rows: Array.from({length: 4}, () => ({q: 0, w: 0, avg: 0, valid: true}))});
  assert.equal(adaptive.pending.mode, 'adaptif'); assert.equal(adaptive.pending.green, 40); assert.ok(adaptive.pending.centroid < 40);
  assert.deepEqual(adaptive.pending.bounds, [40, 50]);
  config.phases[1].fixed = 35; assert.throws(() => validate(config), /per fase/);
});
test('changing output bounds requires matching membership domain and rejects zero aggregation', () => {
  const c = defaults(); c.gmin = 5; c.gmax = 80;
  assert.throws(() => validate(c), /domain/);
  c.fuzzy.green = c.fuzzy.green.map(p => p.map(v => 5 + (v - 10) * 1.5));
  assert.doesNotThrow(() => validate(c)); assert.ok(fuzzy(30, 120, c).green <= 80);
  assert.throws(() => fuzzy(0, 0, {fuzzy: {green: [[70, 70, 75, 80], [70, 75, 80], [70, 75, 80, 80]]}}), /Luas agregasi/);
});
test('recovery uses three successive one-second snapshots and logs fault plus recovery times', () => {
  const c = new Controller({...defaults(), fixed: 10}); c.tick(.1, null);
  c.tick(.1, healthy(.2)); c.tick(.1, healthy(.3)); c.tick(.1, healthy(.4));
  assert.equal(c.validStreak, 1);
  for (let i = 5; i <= 100; i++) c.tick(.1, healthy(i / 10));
  assert.equal(c.pending.mode, 'adaptif');
  assert.equal(c.events.filter(e => e.type === 'gangguan').length, 1);
  const restored = c.events.find(e => e.type === 'pemulihan'); assert.ok(restored); assert.equal(restored.fault_at, 0); assert.ok(Math.abs(restored.recovered_at - 10) < 1e-8);
});
test('same ID reconnects archived observed wait; new ID starts fresh and incomplete tracks export', () => {
  const o = new Observer(defaults()); let s;
  for (let t = 0; t <= 2; t += .25) o.update(t, [north(1)]);
  o.update(3.1, []); assert.equal(o.tracks.size, 0);
  s = o.update(4, [north(1), north(2)]);
  assert.equal(s.tracks.find(t => t.id === 1).wait, 2); assert.equal(s.tracks.find(t => t.id === 2).wait, 0);
  assert.equal(s.rows[0].q, 0);
  s = o.update(5, [north(1), north(2)]); assert.equal(s.rows[0].q, 2);
  assert.equal(s.tracks.find(t => t.id === 1).wait, 3); assert.equal(s.tracks.find(t => t.id === 2).wait, 1);
  assert.equal(o.finish().incomplete_tracks.length, 2);
});
test('per-direction served keys permit one valid crossing per ID in each movement', () => {
  const o = new Observer(defaults()); o.update(0, [north(8, .35)]); o.update(.1, [north(8, .38)]);
  o.update(.2, [{id: 8, class_id: 2, box: [.66, .36, .68, .4]}]); o.update(.3, [{id: 8, class_id: 2, box: [.61, .36, .63, .4]}]);
  assert.deepEqual(o.counts, [1, 1, 0, 0]);
});
test('phase snapshots deduplicate shared IDs and carry valid empty, average and age fields', () => {
  const c = groupedConfig(), o = new Observer(c), s = o.update(0, [], {sourceId: 'clip-1', frameId: 'f-1'});
  assert.equal(s.source_id, 'clip-1'); assert.equal(s.phases[0].q, 0); assert.equal(s.phases[0].avg, 0); assert.equal(s.phases[0].age, 0);
  const rows = Array.from({length: 4}, () => ({q: 1, w: 5, avg: 5, valid: true, vehicles: [{id: 1, wait: 5}]}));
  assert.equal(phaseRows(c, rows, 0).q, 1); assert.equal(phaseRows(c, rows, 0).avg, 5);
});
test('time-weighted queue integrates partial warmup intervals and includes unserved vehicle wait', () => {
  const s = new Simulation(defaults(), 'fixed', []);
  s.time = 4; s.queueIntervals = [{start: 0, end: 1, q: [2, 0, 0, 0]}, {start: 1, end: 4, q: [4, 0, 0, 0]}];
  s.cars = [{id: 1, dir: 0, arrival: .75, departed: null, wait: 3}];
  const m = s.metrics(.5); assert.equal(m.queueArea, 13); assert.equal(m.measurementSeconds, 3.5); assert.equal(m.meanQueue, 13 / 3.5); assert.equal(m.meanWait, 3); assert.equal(m.remaining, 1);
});
test('configured vehicle classes and inference settings are validated and observed', () => {
  const c = defaults(); c.vehicleClasses = [9]; c.confidence = .5; c.imgsz = [736, 1280];
  const o = new Observer(c); let s;
  for (let t = 0; t <= 1; t += .25) s = o.update(t, [{...north(1), class_id: 9}, north(2)]);
  assert.equal(s.rows[0].q, 1); assert.equal(s.tracks[0].id, 1);
  assert.throws(() => validate({...c, vehicleClasses: [9, 9]})); assert.throws(() => validate({...c, confidence: 0})); assert.throws(() => validate({...c, imgsz: 721}));
});
test('AT05 all nine peak combinations select the SRS consequents', () => {
  const expected = [[0, 1, 2], [1, 1, 2], [2, 2, 2]], q = [0, 15, 30], w = [0, 60, 120];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const decision = fuzzy(q[i], w[j]), rule = decision.fires.find(r => r.q === i && r.w === j);
    assert.equal(rule.strength, 1); assert.equal(rule.out, expected[i][j]);
  }
});
test('configuration rejects even tiny uncovered membership gaps and touching zero endpoints', () => {
  const c = defaults(); c.fuzzy.queue[1] = [8.0001, 15, 25];
  assert.throws(() => validate(c), /domain/);
  c.fuzzy.queue[1] = [8, 15, 25]; assert.throws(() => validate(c), /domain/);
});
test('future observations are invalid and recovery follows publication cadence with distinct observations', () => {
  const future = new Controller(defaults()); future.tick(.1, healthy(.2)); assert.equal(future.fallback, true);
  const c = new Controller({...defaults(), fixed: 10}); c.tick(.1, null);
  c.tick(7.9, {...healthy(7.8), published_at: 8});
  c.tick(1, {...healthy(8.4), published_at: 9});
  c.tick(1, {...healthy(9.7), published_at: 10});
  assert.equal(c.pending.mode, 'adaptif'); assert.equal(c.validStreak, 3);
  c.tick(1, {...healthy(9.7), published_at: 11}); assert.equal(c.validStreak, 3);
  const skipped = new Controller(defaults()); skipped.tick(.1, null); skipped.tick(.9, healthy(1)); skipped.tick(2, healthy(3)); assert.equal(skipped.validStreak, 1);
});
