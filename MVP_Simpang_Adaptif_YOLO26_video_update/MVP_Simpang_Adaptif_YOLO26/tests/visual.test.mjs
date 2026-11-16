import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,Simulation} from '../dist/core.js';
import {VisualSimulation,renderSimulationFrame,pairedSummary,validateBaselineLock,auditControl,impactAcceptance,baselinePlan} from '../dist/visual-simulator.js';
import {evaluateAnnotations,iou} from '../scripts/evaluate-annotations.mjs';

test('visual world cannot use truth queues as signal inputs',()=>{
  const config=defaults(),arrivals=Array.from({length:30},(_,i)=>({at:i*.1,dir:1}));
  const world=new VisualSimulation(config,'adaptive',arrivals);
  for(let i=0;i<310;i++)world.step(.1);
  assert.ok(world.world.rows[1].q>0);
  assert.equal(world.controller.decisions[0].mode,'cadangan');
  assert.equal(world.controller.decisions[0].q,null);
  assert.equal(world.controller.decisions[0].green,config.fixed);
});
test('visual controller accepts only explicit perception and affects vehicle movement',()=>{
  const config=defaults(),world=new VisualSimulation(config,'adaptive',[{at:0,dir:1}]);
  for(let i=0;i<350;i++){const snapshot={time:world.controller.time,valid:true,rows:Array.from({length:4},()=>({q:30,w:120,valid:true}))};world.step(.1,snapshot);}
  assert.equal(world.controller.decisions[0].mode,'adaptif');
  assert.equal(world.controller.decisions[0].q,30);
  assert.ok(world.controller.decisions[0].green>config.fixed);
  assert.equal(world.controller.phase,1);
  assert.ok(world.cars[0].pos<.03);
});
test('renderer is deterministic, 1280x720 and contains no identity overlays',()=>{
  const world=new VisualSimulation(defaults(),'fixed',[{at:0,dir:0}]);world.step(.1);
  const a=renderSimulationFrame(world),b=renderSimulationFrame(world);
  assert.equal(a.width,1280);assert.equal(a.height,720);assert.equal(a.data.length,1280*720*4);
  assert.deepEqual(a.data,b.data);assert.equal(a.truth_in_frame,false);
  assert.ok(a.data.every((v,i)=>i%4!==3||v===255));
  assert.throws(()=>renderSimulationFrame(world,{width:1,height:1}));
});
test('paired bootstrap reports direction and reproducible intervals',()=>{
  const results=Array.from({length:15},()=>({adaptive:{meanWait:8,meanQueue:4,throughput:110},fixed:{meanWait:10,meanQueue:5,throughput:100}}));
  const a=pairedSummary(results,{replicates:100}),b=pairedSummary(results,{replicates:100});assert.deepEqual(a,b);
  assert.equal(a.metrics.meanWait.relative_improvement_pct,20);assert.deepEqual(a.metrics.meanWait.paired_bootstrap_95_ci,[-2,-2]);
  assert.equal(a.metrics.throughput.paired_difference,10);assert.equal(a.pairs,15);
});
test('acceptance requires a locked baseline and disjoint development seeds',()=>{
  const lock={schema:'simpang-baseline-lock-v1',locked:true,calibration_sha256:'a'.repeat(64),fixed_green_s:30,horizon_s:1800,warmup_s:300,development_seeds:[101,102]};
  assert.equal(validateBaselineLock(lock),lock);assert.throws(()=>validateBaselineLock({...lock,locked:false}));assert.throws(()=>validateBaselineLock({...lock,development_seeds:[1]}));assert.throws(()=>validateBaselineLock({...lock,horizon_s:60}));
});
test('annotation evaluation counts class-aware matches, misses, false positives and ID switches',()=>{
  const box=[.1,.1,.2,.2],other=[.6,.6,.7,.7];assert.equal(iou(box,box),1);assert.equal(iou(box,other),0);
  const report=evaluateAnnotations({schema:'simpang-annotations-v1',frames:[
    {media_time:0,truth:[{id:'a',class_id:2,box}],detections:[{id:1,class_id:2,box},{id:7,class_id:2,box:other}]},
    {media_time:.1,truth:[{id:'a',class_id:2,box},{id:'b',class_id:2,box:other}],detections:[{id:2,class_id:2,box}]}
  ]});
  assert.equal(report.detection.true_positive,2);assert.equal(report.detection.false_positive,1);assert.equal(report.detection.false_negative,1);assert.equal(report.tracking.id_switches,1);assert.equal(report.tracking.mota,0);
});
test('annotation validation rejects timestamps and duplicated identities',()=>{
  assert.throws(()=>evaluateAnnotations({schema:'simpang-annotations-v1',frames:[{media_time:0,truth:[],detections:[]},{media_time:0,truth:[],detections:[]}]}));
  assert.throws(()=>evaluateAnnotations({schema:'simpang-annotations-v1',frames:[{media_time:0,truth:[{id:'a',class_id:2,box:[2,0,3,1]}],detections:[]}]}));
});
test('annotation evaluation uses configured class IDs for custom weights',()=>{
  const box=[.1,.1,.2,.2],document={schema:'simpang-annotations-v1',vehicle_classes:[0],frames:[{media_time:0,truth:[{id:'car',class_id:0,box}],detections:[{id:1,class_id:0,box},{id:2,class_id:5,box}]}]};
  const result=evaluateAnnotations(document);assert.equal(result.detection.true_positive,1);assert.equal(result.detection.false_positive,0);assert.deepEqual(result.inference_profile.vehicle_classes,[0]);
  assert.throws(()=>evaluateAnnotations({...document,vehicle_classes:[0,0]}));
});
test('visual publication is one second apart and reused frames cannot restore adaptation',()=>{
  const world=new VisualSimulation(defaults());
  for(let i=0;i<25;i++)world.step(.1,{time:world.time,valid:true,rows:Array.from({length:4},()=>({q:0,w:0,valid:true}))});
  assert.equal(world.perceptionFrames,3);assert.ok(Math.abs(world.lastPerception.published_at-2.1)<1e-6);
  const old=world.lastPerception;for(let i=0;i<30;i++)world.step(.1,old);assert.equal(world.perceptionFrames,3);assert.equal(world.controller.fallback,true);
});
test('combined waiting weights vehicles and queue weights measurement time',()=>{
  const results=[{adaptive:{meanWait:0,meanQueue:0,throughput:10,entered:1,measurementSeconds:1},fixed:{meanWait:10,meanQueue:10,throughput:10,entered:1,measurementSeconds:1}},{adaptive:{meanWait:10,meanQueue:10,throughput:10,entered:9,measurementSeconds:9},fixed:{meanWait:10,meanQueue:10,throughput:10,entered:9,measurementSeconds:9}}];
  const summary=pairedSummary(results,{replicates:20});assert.equal(summary.metrics.meanWait.adaptive_mean,9);assert.equal(summary.metrics.meanWait.relative_improvement_pct,10);assert.equal(summary.metrics.meanQueue.adaptive_mean,9);
});
test('calibration baseline overrides phase fallback plans within each phase bounds',()=>{
  const c=defaults();c.phases[1]={...c.phases[1],gmin:25,gmax:50,fixed:40};
  const plan=baselinePlan(c,20);assert.equal(plan.fixed,20);assert.equal(plan.phases[0].fixed,20);assert.equal(plan.phases[1].fixed,25);assert.equal(c.phases[1].fixed,40);
});
test('control audit verifies full30min phase sequence, 196s bound, and detects missing or shortened transitions',()=>{
  const c=defaults(),sim=new Simulation(c,'fixed');for(let i=0;i<18000;i++)sim.tick(.1);
  const audit=auditControl(c,sim.controller.events,sim.controller.decisions,sim.time);assert.equal(audit.nfr05_pass,true);assert.equal(audit.no_skipped_phase,true);assert.equal(audit.red_bound_pass,true);assert.deepEqual(audit.red_bound_s_by_phase,[196,196,196,196]);assert.equal(audit.full_30_minute_horizon,true);assert.equal(audit.complete_decision_log,true);
  const damaged=structuredClone(sim.controller.events);const event=damaged.find(e=>e.state==='SEMUA MERAH');event.time-=1;
  assert.equal(auditControl(c,damaged,sim.controller.decisions,sim.time).nfr05_pass,false);
  assert.equal(auditControl(c,sim.controller.events,[],sim.time).complete_decision_log,false);
});
test('KPI fairness reports a failing direction even when combined mean wait improves',()=>{
  const metrics=(mode)=>({meanWait:mode==='adaptive'?5:10,meanQueue:mode==='adaptive'?4:10,throughput:100,entered:40,measurementSeconds:1500,perDirection:Array.from({length:4},(_,i)=>({p95:mode==='adaptive'?(i===3?11:5):10,waitSamples:[mode==='adaptive'?(i===3?11:5):10]}))});
  const audit={no_skipped_phase:true,red_bound_pass:true,max_same_phase_red_s:100};
  const report=impactAcceptance([{adaptive:metrics('adaptive'),fixed:metrics('fixed'),sessions:{adaptive:{control_audit:audit},fixed:{control_audit:audit}}}]);
  assert.equal(report.KPI01.numerical_target_met,true);assert.equal(report.KPI02.numerical_target_met,true);assert.equal(report.KPI03.per_direction[3].combined_target_met,false);assert.equal(report.KPI03.numerical_target_met,false);
});
test('SRS queue error gate is per ROI and served WAPE includes zero-reference interval false positives',()=>{
  const rows=(q)=>Array.from({length:4},(_,i)=>({q:i===0?q:0,w:0,valid:true}));
  const report=evaluateAnnotations({schema:'simpang-annotations-v1',frames:[{media_time:0,truth:[],detections:[],truth_rows:rows(0),observed_rows:rows(6)}],served_intervals:[{direction:0,start_s:0,end_s:10,truth_count:10,observed_count:11},{direction:0,start_s:10,end_s:20,truth_count:0,observed_count:2}],wait_tracks:[{truth_id:'a',matched_track_id:1,truth_wait_s:10,observed_wait_s:14},{truth_id:'b',matched_track_id:null,truth_wait_s:20,observed_wait_s:null}]});
  assert.equal(report.measurement.queue_mae_vehicles,1.5);assert.equal(report.srs_targets.NFR01.status,'failed numerical target');assert.equal(report.measurement.queue_per_roi[0].absolute_error_p95_vehicles,6);
  assert.equal(report.measurement.served_intervals_per_direction[0].wape_pct,30);assert.equal(report.measurement.served_intervals_per_direction[0].false_positive_when_truth_zero,2);assert.equal(report.measurement.served_intervals_per_direction[1].wape_pct,null);
  assert.equal(report.measurement.wait_matched_path_fraction,.5);assert.equal(report.measurement.matched_track_wait_mae_s,4);assert.equal(report.srs_targets.NFR03.status,'failed numerical target');assert.equal(report.protocol.eligible,false);
});
test('SRS annotated dataset protocol checks300ROI timestamp pairs and60paths with locked disjoint reviewed clips',()=>{
  const rows=Array.from({length:4},()=>({q:0,w:0,valid:true}));
  const doc={schema:'simpang-annotations-v1',source_id:'test-clip',source_sha256:'a'.repeat(64),frames:Array.from({length:75},(_,i)=>({media_time:i,truth:[],detections:[],truth_rows:rows,observed_rows:rows})),wait_tracks:Array.from({length:60},(_,i)=>({truth_id:i,matched_track_id:i,truth_wait_s:2,observed_wait_s:3})),protocol:{annotations_locked:true,reviewers:['rater1','rater2'],disagreements_resolved:true,conditions:['empty','light','heavy','motorcycle','occlusion'],calibration_sources:['dev-clip'],test_sources:['test-clip']}};
  const report=evaluateAnnotations(doc);assert.equal(report.protocol.eligible,true);assert.equal(report.measurement.valid_roi_samples,300);assert.equal(report.tracking.annotated_paths,60);assert.equal(report.measurement.wait_matched_path_fraction,1);assert.match(report.srs_targets.NFR03.status,/numerical target met/);
  assert.equal(evaluateAnnotations({...doc,protocol:{...doc.protocol,calibration_sources:['test-clip']}}).protocol.eligible,false);
});
