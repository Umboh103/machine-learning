import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {defaults,validate,Simulation,Observer,schedule} from '../dist/core.js';
import {VisualSimulation,renderSimulationFrame,pairedSummary,quantile,validateBaselineLock,auditControl,impactAcceptance,baselinePlan} from '../dist/visual-simulator.js';

const args=process.argv.slice(2),arg=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const implementationHashes={core_sha256:hash(readFileSync(new URL('../dist/core.js',import.meta.url),'utf8')),renderer_sha256:hash(readFileSync(new URL('../dist/visual-simulator.js',import.meta.url),'utf8'))};
const write=(path,value)=>{mkdirSync(dirname(resolve(path)),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2));};
const config=arg('--config')?validate(JSON.parse(readFileSync(arg('--config'),'utf8'))):defaults();
const duration=1800,warmup=300,levels=['ringan','sedang','padat'],seeds=[1,2,3,4,5];

// PNG encoding uses Node built-ins. There are no canvas, browser or native
// rendering dependencies and exactly the browser's rasterizer is exercised.
let crcTable;
function crc32(data){crcTable??=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});let c=0xffffffff;for(const b of data)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
function chunk(name,data){const n=Buffer.from(name),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([n,data])));return Buffer.concat([length,n,data,crc]);}
export function encodePNG(frame){const {width,height,data}=frame,scan=Buffer.alloc(height*(width*4+1));for(let y=0;y<height;y++){scan[y*(width*4+1)]=0;Buffer.from(data.buffer,data.byteOffset+y*width*4,width*4).copy(scan,y*(width*4+1)+1);}const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(scan,{level:1})),chunk('IEND',Buffer.alloc(0))]);}

async function calibrate(){
  const developmentSeeds=[101,102,103,104,105],candidates=[20,30,40,50,60],scores=[];
  for(const green of candidates){let sessions=[];const plan=baselinePlan(config,green);for(const level of levels)for(const seed of developmentSeeds){const c={...plan,seed,level,horizon:duration,warmup};const world=new Simulation(c,'fixed',schedule(c,duration));for(let i=0;i<duration*10;i++)world.tick(.1,true);sessions.push({level,seed,metrics:world.metrics(warmup)});}scores.push({fixed_green_s:plan.fixed,fixed_phase_plan:plan.phases,mean_wait_s:sessions.reduce((s,r)=>s+r.metrics.meanWait,0)/sessions.length,sessions});console.log(`calibration fixed=${green}s done`);}
  scores.sort((a,b)=>a.mean_wait_s-b.mean_wait_s||a.fixed_green_s-b.fixed_green_s);
  const result={schema:'simpang-baseline-calibration-v1',created_at:new Date().toISOString(),source_scope:'procedural queue simulator; development ground truth for baseline selection only',objective:'minimum development mean wait; equal weighting of level and seed',implementation:implementationHashes,config,config_sha256:hash(config),development_seeds:developmentSeeds,horizon_s:duration,warmup_s:warmup,candidates:scores,selected_fixed_green_s:scores[0].fixed_green_s};
  const path=arg('--out','validation/baseline-development.json');write(path,result);console.log(`Saved ${path}; lock before test runs.`);
}
function lockBaseline(){
  const calibrationPath=arg('--lock'),raw=readFileSync(calibrationPath,'utf8'),cal=JSON.parse(raw);
  if(cal.schema!=='simpang-baseline-calibration-v1'||!cal.candidates?.length||!cal.config_sha256)throw Error('Kalibrasi baseline tidak valid.');
  if(hash(cal.config)!==cal.config_sha256)throw Error('Konfigurasi kalibrasi telah berubah.');
  if(JSON.stringify(cal.implementation)!==JSON.stringify(implementationHashes))throw Error('Source simulator berubah setelah kalibrasi. Kalibrasi ulang.');
  const result={schema:'simpang-baseline-lock-v1',locked:true,locked_at:new Date().toISOString(),calibration_path:resolve(calibrationPath),calibration_sha256:hash(raw),implementation:cal.implementation,config_sha256:cal.config_sha256,config:cal.config,fixed_green_s:cal.selected_fixed_green_s,fixed_phase_plan:cal.candidates[0].fixed_phase_plan,development_seeds:cal.development_seeds,horizon_s:cal.horizon_s,warmup_s:cal.warmup_s,source_scope:cal.source_scope};
  validateBaselineLock(result);const path=arg('--out','validation/baseline-lock.json');write(path,result);console.log(`Saved immutable baseline parameters to ${path}`);
}
async function infer(base,sessionId,frame,mediaTime,frameId,signal){
  const body=new FormData();body.append('frame',new Blob([encodePNG(frame)],{type:'image/png'}),'simulator.png');body.append('session_id',sessionId);body.append('media_time',String(mediaTime));body.append('frame_id',String(frameId));body.append('original_width',String(frame.width));body.append('original_height',String(frame.height));
  const response=await fetch(`${base}/api/track`,{method:'POST',body,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});
  if(!response.ok)throw Error(`Inference HTTP ${response.status}: ${await response.text()}`);return response.json();
}
async function runSession(c,mode,arrivals,seconds,base,fps){
  const sessionId=randomUUID(),world=new VisualSimulation(c,mode,arrivals),observer=new Observer(c);
  const startResponse=await fetch(`${base}/api/sessions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:sessionId,config:c,source:'visual-simulator',source_name:'procedural-raster-v1',mode,metadata:{ground_truth_control_input:false,renderer_validated:false,arrival_schedule_sha256:hash(arrivals)}})});
  if(!startResponse.ok)throw Error(`Session HTTP ${startResponse.status}: ${await startResponse.text()}`);
  let times=[],frames=0,detectionFrames=0,emptyFrames=0,modelMetadata=null,truthVehicleFrames=0,detectedVehicleFrames=0;
  let events=[],decisionIndex=0,transitionIndex=0,publishedSnapshots=0,lastSnapshotTime=-Infinity,lastObservation=null,pendingCaptures=[],snapshotTimes=[],journalError=null,flushTask=Promise.resolve();
  const abort=new AbortController();
  const flush=()=>{if(!events.length)return flushTask;const batch=events;events=[];flushTask=flushTask.then(async()=>{const response=await fetch(`${base}/api/sessions/${sessionId}/events`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({events:batch})});if(!response.ok)throw Error(`Journal HTTP ${response.status}: ${await response.text()}`);});return flushTask;};
  const started=performance.now();let nextJournalTime=1;
  const collect=()=>{
    if(world.lastPerception&&world.lastPerception.time>lastSnapshotTime+1e-7){const publishedAt=performance.now();snapshotTimes.push(...pendingCaptures.map(t=>publishedAt-t));pendingCaptures=[];publishedSnapshots++;lastSnapshotTime=world.lastPerception.time;events.push({type:'snapshot',time:world.lastPerception.published_at,media_time:world.lastPerception.media_time,data:world.lastPerception});}
    for(const decision of world.controller.decisions.slice(decisionIndex))events.push({type:'decision',time:decision.time,data:decision});decisionIndex=world.controller.decisions.length;
    for(const transition of world.controller.events.slice(transitionIndex))events.push({type:transition.type==='gangguan'?'fault':transition.type==='pemulihan'?'recovery':'transition',time:transition.time,data:transition});transitionIndex=world.controller.events.length;
  };
  const clockTimer=setInterval(()=>{
    if(journalError)return;
    const target=Math.min(seconds,(performance.now()-started)/1000);
    while(world.time+.1<=target+1e-7){world.step(.1,lastObservation);collect();}
    if(target>=seconds-1e-7&&world.time<seconds-1e-7){world.step(seconds-world.time,lastObservation);collect();}
    if(world.time>=nextJournalTime){nextJournalTime=Math.floor(world.time)+1;flush().catch(error=>{journalError=error;abort.abort(error);clearInterval(clockTimer);});}
    if(world.time>=seconds-1e-7)clearInterval(clockTimer);
  },10);
  let nextCapture=started;
  try{
    while(world.time<seconds-1e-7){
      if(journalError)throw journalError;
      const delay=nextCapture-performance.now();if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));if(world.time>=seconds-1e-7)break;
      // The .1s world clock continues while inference is pending. Capture
      // timestamps remain attached to these pixels, never the response time.
      const captured=performance.now(),mediaTime=Math.min(seconds-1e-7,(captured-started)/1000),truthCount=world.cars.length;
      const frame=renderSimulationFrame(world),out=await infer(base,sessionId,frame,mediaTime,++frames,abort.signal);
      const observation=observer.update(mediaTime,out.detections);modelMetadata=out.metadata;
      observation.media_time=mediaTime;observation.time=mediaTime;observation.frame_id=frames;
      lastObservation=observation;
      pendingCaptures.push(captured);truthVehicleFrames+=truthCount;detectedVehicleFrames+=out.detections.length;
      if(out.detections.length)detectionFrames++;else emptyFrames++;
      events.push({type:'measurement',time:observation.time,media_time:observation.media_time,data:observation});
      times.push(performance.now()-captured);nextCapture=Math.max(nextCapture+1000/fps,performance.now());
      if(frames%(fps*60)===0)console.log(`${c.level}/${c.seed}/${mode}: ${world.time.toFixed(0)}s media, ${(frames/((performance.now()-started)/1000)).toFixed(2)} FPS`);
    }
    // Flush the final partial second at normal end so no processed frame is
    // silently omitted from the frame-to-snapshot latency distribution.
    clearInterval(clockTimer);if(journalError)throw journalError;
    if(pendingCaptures.length){const publishedAt=performance.now();snapshotTimes.push(...pendingCaptures.map(t=>publishedAt-t));pendingCaptures=[];publishedSnapshots++;events.push({type:'snapshot',time:world.time,media_time:lastObservation.media_time,data:{...lastObservation,age:Math.max(0,world.time-lastObservation.time),valid:world.time-lastObservation.time<=(c.snapshotMaxAge??2),final:true}});}
    await flush();
    const elapsed=(performance.now()-started)/1000,p95=quantile(snapshotTimes,.95),metrics=world.metrics(Math.min(c.warmup??warmup,Math.max(0,seconds-.1)));
    const warmFrames=Math.max(0,frames-1),warmElapsed=Math.max(0,elapsed-(times[0]??0)/1000);
    const truthVehicles=[...world.cars,...world.departed].sort((a,b)=>a.id-b.id).map(v=>({id:v.id,direction:v.dir,arrival_s:v.arrival,departure_s:v.departed,wait_s:v.wait,final_position:v.pos,unfinished:v.departed===null}));
    const result={session_id:sessionId,mode,metrics,decisions:world.controller.decisions,transitions:world.controller.events,control_audit:auditControl(c,world.controller.events,world.controller.decisions,world.time),served_visual:observer.counts,ground_truth:{usage:'evaluation only; never perception/controller input',initial_queue:[0,0,0,0],final_queue:world.world.rows.map(r=>r.q),departures:world.departed.length,unfinished:truthVehicles.filter(v=>v.unfinished),vehicles:truthVehicles,queue_history:world.truthHistory},performance:{processed_frames:frames,published_snapshots:publishedSnapshots,elapsed_wall_s:elapsed,effective_fps:frames/elapsed,frame_to_snapshot_p95_ms:p95,first_frame_to_snapshot_ms:snapshotTimes[0]??null,after_first_frame:{processed_frames:warmFrames,elapsed_wall_s:warmElapsed,effective_fps:warmElapsed>0?warmFrames/warmElapsed:null,frame_to_snapshot_p95_ms:quantile(snapshotTimes.slice(1),.95),scope:'first request excluded; short smoke is not sustained acceptance'},frame_to_observation_p95_ms:quantile(times,.95),frame_to_snapshot_samples_ms:snapshotTimes,latency_scope:'each captured frame to first subsequent snapshot publication, including 1s scheduling and final partial-second flush; all processed frames included',target_fps:10,target_p95_ms:1000,performance_pass:frames/elapsed>=10&&p95<=1000},perception_diagnostics:{detection_frames:detectionFrames,empty_frames:emptyFrames,truth_vehicle_frames:truthVehicleFrames,detected_vehicle_frames:detectedVehicleFrames,scope:'counts diagnostic only; not detection precision/recall or tracking accuracy'},model_metadata:modelMetadata};
    const persisted=await fetch(`${base}/api/sessions/${sessionId}/events`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({events:[{type:'evaluation_complete',time:world.time,data:result}]})});
    if(!persisted.ok)throw Error(`Evaluation log HTTP ${persisted.status}: ${await persisted.text()}`);
    const ended=await fetch(`${base}/api/sessions/${sessionId}/end`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'ended',time:world.time,reason:'evaluation_complete'})});if(!ended.ok)throw Error(`Session end HTTP ${ended.status}: ${await ended.text()}`);
    const exported=await fetch(`${base}/api/sessions/${sessionId}/export?format=json`);if(!exported.ok)throw Error('Durable session export is unreadable.');const journal=await exported.json();
    const eventCounts=journal.events.reduce((counts,event)=>({...counts,[event.type]:(counts[event.type]??0)+1}),{});
    result.journal_verification={readable:true,status:journal.status,event_counts:eventCounts,decisions_complete:(eventCounts.decision??0)===world.controller.decisions.length,snapshots_complete:eventCounts.snapshot===publishedSnapshots,measurements_complete:eventCounts.measurement===frames};
    result.nfr07={full_30_minutes:world.time>=1800-1e-6,process_completed:true,decision_transition_logs_readable:result.journal_verification.decisions_complete&&world.controller.events.length===(eventCounts.transition??0)+(eventCounts.fault??0)+(eventCounts.recovery??0)};
    if(!result.journal_verification.decisions_complete||!result.journal_verification.snapshots_complete||!result.journal_verification.measurements_complete||!result.nfr07.decision_transition_logs_readable)throw Error('Mandatory journal is incomplete.');
    return result;
  }catch(error){clearInterval(clockTimer);write(`validation/failed-${sessionId}.json`,{session_id:sessionId,error:String(error),media_time:world.time,processed_frames:frames,decisions:world.controller.decisions});await fetch(`${base}/api/sessions/${sessionId}/end`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'failed',time:world.time,reason:'evaluation_failed',error:String(error)})}).catch(()=>{});throw error;}
}
async function run(){
  const smoke=args.includes('--smoke'),baselinePath=arg('--baseline','validation/baseline-lock.json');
  let lock;if(!smoke){lock=validateBaselineLock(JSON.parse(readFileSync(baselinePath,'utf8')));if(!existsSync(lock.calibration_path)||hash(readFileSync(lock.calibration_path,'utf8'))!==lock.calibration_sha256)throw Error('Checksum kalibrasi baseline berbeda atau berkas hilang.');const calibration=JSON.parse(readFileSync(lock.calibration_path,'utf8'));if(lock.fixed_green_s!==calibration.selected_fixed_green_s||JSON.stringify(lock.fixed_phase_plan)!==JSON.stringify(calibration.candidates[0].fixed_phase_plan))throw Error('Rencana baseline berubah setelah dikunci.');if(hash(config)!==lock.config_sha256)throw Error('Konfigurasi berubah setelah kalibrasi. Gunakan --config yang sama atau kalibrasi ulang.');if(JSON.stringify(lock.implementation)!==JSON.stringify(implementationHashes))throw Error('Source simulator berubah setelah baseline dikunci. Kalibrasi ulang.');}
  const fps=Number(arg('--fps','10'));if(!Number.isFinite(fps)||fps<2||fps>30)throw Error('FPS harus 2–30.');
  const seconds=smoke?Number(arg('--seconds','3')):duration;if(!Number.isFinite(seconds)||seconds<=0||seconds>duration)throw Error('Durasi uji tidak valid.');
  const base=arg('--backend','http://127.0.0.1:8000').replace(/\/$/,''),path=arg('--out',smoke?'validation/visual-smoke.json':'validation/visual-acceptance.json');
  const report={schema:'simpang-visual-evaluation-v1',created_at:new Date().toISOString(),scope:smoke?'pipeline smoke; not acceptance':'15 paired visual feedback evaluations; procedural renderer unvalidated',acceptance_status:'pending annotated detector validation and simulator validation',implementation:{...implementationHashes,evaluator_sha256:hash(readFileSync(new URL(import.meta.url),'utf8'))},environment:{node:process.version,platform:process.platform,architecture:process.arch,cpu:cpus()[0]?.model,logical_cpus:cpus().length},horizon_s:seconds,warmup_s:smoke?0:warmup,frames_per_media_second:fps,baseline_lock:lock??null,truth_as_controller_input:false,renderer:'procedural-raster-v1',results:[]};
  for(const level of smoke?['sedang']:levels)for(const seed of smoke?[101]:seeds){
    const c={...(lock?baselinePlan(config,lock.fixed_green_s):config),level,seed,horizon:seconds,warmup:smoke?0:warmup},arrivals=schedule(c,seconds);
    // Smoke needs visible vehicles without waiting their normal travel time.
    if(smoke)arrivals.unshift({at:0,dir:0},{at:0,dir:1},{at:0,dir:2},{at:0,dir:3});
    const adaptive=await runSession(c,'adaptive',arrivals,seconds,base,fps),fixed=await runSession(c,'fixed',arrivals,seconds,base,fps);
    report.results.push({scenario:{scenario_id:`${level}-seed-${seed}`,level,seed,arrival_schedule_sha256:hash(arrivals),arrivals:arrivals.length,config:c,pair_equivalence:{same_geometry:true,same_routes:true,same_vehicle_types:true,same_initial_queue:true,same_arrivals:true,same_seed:true,same_phase_transitions:true,horizon_s:seconds,warmup_s:c.warmup}},adaptive:adaptive.metrics,fixed:fixed.metrics,sessions:{adaptive,fixed}});
    report.summary=pairedSummary(report.results);report.impact_targets=impactAcceptance(report.results);write(path,report);console.log(`Saved ${report.results.length}/${smoke?1:15} pairs to ${path}`);
  }
  report.finished_at=new Date().toISOString();report.performance_pass=report.results.every(r=>Object.values(r.sessions).every(s=>s.performance.performance_pass));
  write(path,report);console.log(JSON.stringify({output:path,pairs:report.results.length,performance_pass:report.performance_pass,acceptance:report.acceptance_status}));
}

if(args.includes('--calibrate'))await calibrate();
else if(args.includes('--lock'))lockBaseline();
else if(args.includes('--run')||args.includes('--smoke'))await run();
else console.log('Usage:\n  node scripts/evaluate-visual.mjs --calibrate\n  node scripts/evaluate-visual.mjs --lock validation/baseline-development.json\n  node scripts/evaluate-visual.mjs --smoke --seconds 3\n  node scripts/evaluate-visual.mjs --run --baseline validation/baseline-lock.json\nFull evaluation: 15 pairs, 1800s each, warmup300; real YOLO requests every frame. No acceptance from unvalidated procedural renderings.');
