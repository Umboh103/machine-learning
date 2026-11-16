import {Simulation, schedule, rng,phaseConfig,phaseTiming} from './core.js';

// Perception and truth have separate paths. The world's telemetry snapshots are
// retained for evaluation, and are never passed to the signal controller here.
export class VisualSimulation {
  constructor(config, mode='adaptive', arrivals=null) {
    this.config=structuredClone(config);
    this.world=new Simulation(config, mode, arrivals??schedule(config, config.horizon??1800));
    this.controller=this.world.controller;
    const movementSignals=Object.create(this.controller);
    movementSignals.tick=()=>{};
    this.world.controller=movementSignals;
    this.lastPerception=null;
    this.perceptionFrames=0;
    this.source='procedural-visual-simulator';
  }
  get time(){return this.world.time;}
  get cars(){return this.world.cars;}
  get departed(){return this.world.departed;}
  get truthHistory(){return this.world.history;}
  step(dt=.1, perceptionSnapshot=null) {
    if(!Number.isFinite(dt)||dt<=0||dt>.5)throw Error('Langkah simulator harus >0 dan <=0.5 detik.');
    this.world.tick(dt,true);
    const previous=this.lastPerception,newObservation=perceptionSnapshot&&(!previous||perceptionSnapshot.time>previous.time+1e-9||perceptionSnapshot.valid!==previous.valid);
    if(newObservation&&(!previous||!perceptionSnapshot.valid||!previous.valid||this.world.time-previous.published_at>=.999999)){
      this.lastPerception={...perceptionSnapshot,published_at:this.world.time};this.perceptionFrames++;
    }
    this.controller.tick(dt,this.lastPerception);
    return this;
  }
  metrics(warmup=300){return this.world.metrics(warmup);}
  render(canvas) {
    const frame=renderSimulationFrame(this);
    canvas.width=frame.width;canvas.height=frame.height;
    const context=canvas.getContext('2d');
    const image=context.createImageData(frame.width,frame.height);
    image.data.set(frame.data);context.putImageData(image,0,0);
    return canvas;
  }
}

// Identical rasterizer in browser and CLI. This is a procedural test scene,
// not photorealistic traffic: detector coverage must be measured, never assumed.
export function renderSimulationFrame(sim,{width=1280,height=720}={}) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<64||height<64||width>3840||height>2160)throw Error('Ukuran frame tidak valid.');
  const data=new Uint8Array(width*height*4);
  function rect(x,y,w,h,color){
    const left=Math.max(0,Math.floor(x*width)),right=Math.min(width,Math.ceil((x+w)*width));
    const top=Math.max(0,Math.floor(y*height)),bottom=Math.min(height,Math.ceil((y+h)*height));
    for(let py=top;py<bottom;py++)for(let px=left;px<right;px++){const o=(py*width+px)*4;data[o]=color[0];data[o+1]=color[1];data[o+2]=color[2];data[o+3]=255;}
  }
  rect(0,0,1,1,[81,107,73]);
  const blocks=[[.015,.02,.29,.25],[.7,.02,.28,.25],[.015,.73,.29,.25],[.7,.73,.28,.25]];
  for(const [x,y,w,h]of blocks){rect(x,y,w,h,[148,149,136]);for(let i=0;i<4;i++)rect(x+.015+i*.067,y+.025,.052,.19,[186-i*8,178-i*7,155-i*4]);}
  rect(.32,0,.36,1,[63,65,65]);rect(0,.32,1,.36,[63,65,65]);
  for(let y=0;y<1;y+=.07)if(y<.3||y>.7)rect(.497,y,.006,.035,[220,199,91]);
  for(let x=0;x<1;x+=.055)if(x<.3||x>.7)rect(x,.497,.028,.008,[220,199,91]);
  [[.34,.35,.15,.005],[.64,.34,.004,.15],[.51,.64,.15,.005],[.36,.51,.004,.15]].forEach(r=>rect(...r,[236,235,223]));
  const lightPosition=[[.305,.29],[.7,.29],[.7,.7],[.305,.7]],controller=sim.controller;
  for(let i=0;i<4;i++){
    const active=controller.activeRois??[controller.phase];
    const signal=active.includes(i)?controller.state:'MERAH';
    rect(...lightPosition[i],.012,.02,signal==='HIJAU'?[50,211,80]:signal==='KUNING'?[248,189,49]:[228,55,43]);
  }
  const palette=[[215,222,227],[33,89,151],[167,40,34],[217,191,118],[33,39,43]];
  for(const car of sim.cars){
    let x,y,vertical=car.dir%2===0;
    if(car.dir===0){x=.415;y=.36-car.pos*.28;}
    else if(car.dir===1){x=.64+car.pos*.28;y=.415;}
    else if(car.dir===2){x=.585;y=.64+car.pos*.28;}
    else{x=.36-car.pos*.28;y=.585;}
    const w=vertical?.018:.039,h=vertical?.047:.025;
    if(x<-.05||x>1.05||y<-.05||y>1.05)continue;
    const color=palette[car.id%palette.length];
    rect(x-w/2+.002,y-h/2+.003,w,h,[30,31,29]);
    rect(x-w/2,y-h/2,w,h,color);
    rect(x-w*.35,y-h*.29,w*.7,h*.18,[41,61,69]);
    rect(x-w*.35,y+h*.19,w*.7,h*.14,[41,61,69]);
    rect(x-w*.31,y-h*.04,w*.62,h*.19,color.map(v=>Math.min(255,v+12)));
  }
  return{width,height,data,renderer:'procedural-raster-v1',truth_in_frame:false};
}

export function quantile(values,p){if(!values.length)return null;const a=[...values].sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.max(0,Math.ceil(p*a.length)-1))];}
export function baselinePlan(config,green){
  if(!Number.isFinite(green))throw Error('Baseline harus berupa angka.');
  const copy=structuredClone(config);copy.fixed=Math.max(config.gmin,Math.min(config.gmax,green));
  copy.phases=phaseConfig(config).phases.map((phase,index)=>{const limits=phaseTiming(config,index);return{...structuredClone(phase),fixed:Math.max(limits.gmin,Math.min(limits.gmax,copy.fixed))};});
  return copy;
}
const combined=(results,mode,key)=>{let sum=0,weight=0;for(const r of results){const m=r[mode],w=key==='meanWait'?(m.entered??1):(m.measurementSeconds??1);sum+=m[key]*w;weight+=w;}return weight?sum/weight:0;};
export function pairedSummary(results,{replicates=5000,seed=90210}={}){
  if(!results.length)return{pairs:0,status:'pending',metrics:{}};
  const random=rng(seed),metrics={};
  for(const key of ['meanWait','meanQueue','throughput']){
    const differences=results.map(r=>r.adaptive[key]-r.fixed[key]);
    const mean=differences.reduce((s,v)=>s+v,0)/differences.length,boot=[];
    for(let b=0;b<replicates;b++){let total=0;for(let i=0;i<differences.length;i++)total+=differences[Math.floor(random()*differences.length)];boot.push(total/differences.length);}
    const a=combined(results,'adaptive',key),f=combined(results,'fixed',key);
    metrics[key]={adaptive_mean:a,fixed_mean:f,paired_difference:mean,paired_bootstrap_95_ci:[quantile(boot,.025),quantile(boot,.975)],relative_improvement_pct:f===0?null:100*(f-a)/f};
  }
  return{pairs:results.length,status:results.length===15?'computed; acceptance requires detector and performance gates':'partial',aggregation:'meanWait weighted by entered vehicles; meanQueue and throughput weighted by measurement duration; paired difference and bootstrap are unweighted pair differences',confidence_interval_method:'paired nonparametric bootstrap; pairs resampled; 5000 replicates by default',metrics};
}

export function auditControl(config,events,decisions,horizon){
  const {phases,order,conflicts}=phaseConfig(config),states=[{time:0,state:'HIJAU',phase:order[0]},...events.filter(e=>['HIJAU','KUNING','SEMUA MERAH'].includes(e.state))];
  const failures=[],redIntervals=[],redStarts=new Map(),bounds=phases.map((_,phase)=>phases.reduce((s,__,i)=>s+(i===phase?0:phaseTiming(config,i).gmax),0)+phases.length*(config.yellow+config.allred));
  let maxRed=0;
  for(let i=0;i<states.length;i++){
    const current=states[i],prior=states[i-1];
    if(current.state==='HIJAU'){
      const rois=phases[current.phase]?.rois??[];if(!rois.length)failures.push({type:'invalid_phase',time:current.time});
      for(const a of rois)for(const b of rois)if(a!==b&&conflicts[a]?.[b])failures.push({type:'conflicting_green',time:current.time,a,b});
      if(redStarts.has(current.phase)){const seconds=current.time-redStarts.get(current.phase);maxRed=Math.max(maxRed,seconds);redIntervals.push({phase:current.phase,seconds,bound:bounds[current.phase]});if(seconds>bounds[current.phase]+1e-6)failures.push({type:'red_bound',phase:current.phase,seconds});redStarts.delete(current.phase);}
    }else if(current.state==='KUNING')redStarts.set(current.phase,current.time);
    if(!prior)continue;
    const dt=current.time-prior.time,expected={HIJAU:'KUNING',KUNING:'SEMUA MERAH','SEMUA MERAH':'HIJAU'}[prior.state];
    if(current.state!==expected)failures.push({type:'skipped_transition',prior,current});
    if(prior.state==='HIJAU'){const timing=phaseTiming(config,prior.phase);if(dt<timing.gmin-1e-6||dt>timing.gmax+1e-6)failures.push({type:'green_bounds',phase:prior.phase,seconds:dt});}
    else if(Math.abs(dt-(prior.state==='KUNING'?config.yellow:config.allred))>1e-6)failures.push({type:'transition_duration',prior:prior.state,seconds:dt});
    const expectedPhase=prior.state==='SEMUA MERAH'?order[(order.indexOf(prior.phase)+1)%order.length]:prior.phase;
    if(current.phase!==expectedPhase)failures.push({type:'skipped_phase',expected:expectedPhase,actual:current.phase,time:current.time});
  }
  for(const [phase,start]of redStarts){const seconds=horizon-start;maxRed=Math.max(maxRed,seconds);if(seconds>bounds[phase]+1e-6)failures.push({type:'red_bound_incomplete',phase,seconds});}
  for(const decision of decisions){const timing=phaseTiming(config,decision.to);if(!Number.isFinite(decision.green)||decision.green<timing.gmin-1e-6||decision.green>timing.gmax+1e-6)failures.push({type:'decision_bounds',decision_at:decision.time});}
  const greenEnds=states.filter(s=>s.state==='KUNING');
  const completeDecisionLog=greenEnds.length===decisions.length&&greenEnds.every(e=>decisions.some(d=>Math.abs(d.time-e.time)<1e-6&&d.from===e.phase));
  if(!completeDecisionLog)failures.push({type:'missing_decision_log'});
  return{nfr05_pass:!failures.some(f=>['invalid_phase','conflicting_green','skipped_transition','green_bounds','transition_duration','skipped_phase','decision_bounds'].includes(f.type)),no_skipped_phase:!failures.some(f=>['skipped_phase','skipped_transition'].includes(f.type)),red_bound_pass:!failures.some(f=>f.type.startsWith('red_bound')),max_same_phase_red_s:maxRed,red_bound_s_by_phase:bounds,complete_decision_log:completeDecisionLog,complete_transition_records:states.length-1,full_30_minute_horizon:horizon>=1800-1e-6,red_intervals:redIntervals,failures};
}

export function impactAcceptance(results){
  if(!results.length)return{status:'pending visual pairs',pairs:0};
  const waitA=combined(results,'adaptive','meanWait'),waitF=combined(results,'fixed','meanWait'),queueA=combined(results,'adaptive','meanQueue'),queueF=combined(results,'fixed','meanQueue'),throughA=combined(results,'adaptive','throughput'),throughF=combined(results,'fixed','throughput');
  const reduction=(a,b)=>b===0?null:100*(b-a)/b;
  const directions=Array.from({length:4},(_,direction)=>{
    const a=results.flatMap(r=>r.adaptive.perDirection?.[direction]?.waitSamples??[]),f=results.flatMap(r=>r.fixed.perDirection?.[direction]?.waitSamples??[]);
    const adaptiveP95=quantile(a,.95),fixedP95=quantile(f,.95),pairs=results.map((r,index)=>{const ap=r.adaptive.perDirection?.[direction]?.p95,fp=r.fixed.perDirection?.[direction]?.p95;return{pair:index,adaptive_p95_s:ap??null,fixed_p95_s:fp??null,ratio:fp?ap/fp:null,absolute_difference_s:ap==null||fp==null?null:ap-fp,target_met:ap==null||fp==null?null:ap<=fp*1.05+1e-9};});
    return{direction,adaptive_p95_s:adaptiveP95,fixed_p95_s:fixedP95,combined_target_met:adaptiveP95===null||fixedP95===null?null:adaptiveP95<=fixedP95*1.05+1e-9,worst_pair_ratio:Math.max(0,...pairs.map(p=>p.ratio??0)),pairs,all_pair_targets_met:pairs.every(p=>p.target_met===true)};
  });
  const audits=results.flatMap(r=>Object.values(r.sessions??{}).map(s=>s.control_audit)),controlAvailable=audits.length===results.length*2&&audits.every(Boolean);
  const nominalFailures=[];if(!controlAvailable)nominalFailures.push('control evidence pending');
  const waitImprovement=reduction(waitA,waitF),queueImprovement=reduction(queueA,queueF);
  return{status:results.length===15?'computed; renderer/annotation/performance gates still required':'partial; cannot accept AT10',pairs:results.length,KPI01:{adaptive_mean_wait_s:waitA,fixed_mean_wait_s:waitF,reduction_pct:waitImprovement,absolute_difference_s:waitA-waitF,target_reduction_pct:10,numerical_target_met:waitImprovement===null?null:waitImprovement>=10},KPI02:{adaptive_time_weighted_queue:queueA,fixed_time_weighted_queue:queueF,queue_reduction_pct:queueImprovement,queue_absolute_difference:queueA-queueF,throughput_ratio:throughF?throughA/throughF:null,throughput_absolute_difference:throughA-throughF,numerical_target_met:queueImprovement===null?null:queueImprovement>=10&&throughA>=throughF*.95},KPI03:{per_direction:directions,no_skipped_phase:controlAvailable?audits.every(a=>a.no_skipped_phase):null,red_bound_pass:controlAvailable?audits.every(a=>a.red_bound_pass):null,max_red_s:controlAvailable?Math.max(...audits.map(a=>a.max_same_phase_red_s)):null,numerical_target_met:!controlAvailable||directions.some(d=>d.combined_target_met===null)?null:directions.every(d=>d.combined_target_met===true&&d.all_pair_targets_met)&&audits.every(a=>a.no_skipped_phase&&a.red_bound_pass)},scope_notes:['all p95 directions and each pair reported; zero baseline uses absolute difference',...nominalFailures]};
}

export function validateBaselineLock(lock){
  if(lock?.schema!=='simpang-baseline-lock-v1'||lock.locked!==true||!lock.calibration_sha256||!/^[a-f0-9]{64}$/.test(lock.calibration_sha256))throw Error('Baseline harus dikalibrasi dan dikunci.');
  if(!Number.isFinite(lock.fixed_green_s)||lock.fixed_green_s<10||lock.fixed_green_s>60)throw Error('Baseline hijau di luar domain.');
  if(lock.horizon_s!==1800||lock.warmup_s!==300)throw Error('Penerimaan membutuhkan 1800 detik dengan warmup 300 detik.');
  if(!Array.isArray(lock.development_seeds)||!lock.development_seeds.length||new Set(lock.development_seeds).size!==lock.development_seeds.length||lock.development_seeds.some(v=>!Number.isInteger(v)||v<0||[1,2,3,4,5].includes(v)))throw Error('Seed kalibrasi harus unik dan terpisah dari seed uji 1–5.');
  return lock;
}
