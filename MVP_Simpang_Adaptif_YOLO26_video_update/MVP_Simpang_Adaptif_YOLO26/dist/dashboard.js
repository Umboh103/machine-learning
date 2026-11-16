import {DIRS, defaults, validate, Simulation, Controller, Observer, paired, phaseConfig} from './core.js';
import {VisualSimulation, renderSimulationFrame} from './visual-simulator.js';
import {SessionLog} from './session-log.js';
import {RecordedSimulator} from './recorded-simulator.js';
import {FileHash} from './file-hash.js';

const $=id=>document.getElementById(id);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let config=defaults();try{config=validate(JSON.parse(localStorage.getItem('simpang-config'))||config);}catch{}
let source='video',mode='adaptive',sim,controller,observer,status='ready',sessionId='',fault=false;
let snapshot=null,detections=[],frames=[],latencies=[],published=0,activeWall=0,mediaTime=-1,frameId=0;
let generation=0,busy=false,abort=null,transitioning=false,last=performance.now(),accumulator=0,lastDraw=0,lastCapture=-Infinity;
let decisionCursor=0,transitionCursor=0,historyCursor=0,lastQuality=null,lastError='',videoUrl=null,sourceHash=null,hashPromise=null;
let edit=null,points=[],experiment=null,presentedTime=-1,hasObserved=false;
let latestMeasurement=null,lastPublication=-1,lastLatencyFrame=-1;
let startupMs=null;
let recorded=null,lastOutput=-1,profileId=null,backendOnline=null,hashProgress=0,fileGeneration=0,configDirty=false;
const fileHash=new FileHash();
const scene=$('scene'),ctx=scene.getContext('2d'),video=$('video');
const capture=document.createElement('canvas'),observed=document.createElement('canvas');
const logger=new SessionLog({onStatus:message=>{$('persistStatus').textContent=message;},onFailure:error=>{if(active())end('mandatory-log-failure: '+error.message,true);}});
const active=()=>status==='running'||status==='paused';
const running=()=>status==='running';
function toast(message){$('toast').textContent=message;$('toast').style.display='block';clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').style.display='none',6000);}
function navigate(tab){document.querySelectorAll('.tab').forEach(e=>e.classList.toggle('active',e.id===tab));document.querySelectorAll('.nav').forEach(e=>e.classList.toggle('active',e.dataset.tab===tab));$('pageTitle').textContent={monitor:'Pemantauan lalu lintas',config:'Konfigurasi persimpangan',experiment:'Evaluasi pengendali',logs:'Catatan sesi',guide:'Panduan penggunaan'}[tab];}
document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>navigate(b.dataset.tab));
function download(name,data,type='application/json'){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([typeof data==='string'?data:JSON.stringify(data,null,2)],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function record(type,data={},extra={}){logger.append(sessionId,type,controller?.time??0,data,extra);}
function readiness(){
  if(transitioning)return 'Menyiapkan sesi. Video dan jam simulator belum berjalan.';
  if(active())return status==='paused'?'Sesi dijeda. Lanjutkan untuk meneruskan video dan simulator.':'Sesi berjalan. Konfigurasi dikunci.';
  if(configDirty)return 'Simpan konfigurasi sebelum memulai.';
  if(backendOnline!==true)return 'Backend belum tersedia. Jalankan start.cmd di folder proyek.';
  if(source==='video'){
    if(!video.videoWidth||video.error)return 'Pilih berkas rekaman CCTV yang dapat diputar pada Konfigurasi.';
    if(!sourceHash)return `Memeriksa checksum rekaman: ${Math.round(hashProgress*100)}%.`;
    const geometry=config.cameraGeometry;
    if(geometry&&Math.abs(geometry.width/geometry.height-video.videoWidth/video.videoHeight)>.01)return 'Rasio gambar berbeda dari profil. Pilih Profil baru dan sesuaikan keempat ROI.';
    if(!$('geometryConfirmed').checked)return 'Periksa ROI dan garis keluar, lalu konfirmasikan kesesuaian kamera pada Konfigurasi.';
  }
  return null;
}
function lock(){document.querySelectorAll('#config input:not(#fault),#config select,#config textarea,#config button').forEach(e=>e.disabled=active()||transitioning);$('fault').disabled=transitioning;$('start').disabled=transitioning||(!active()&&!!readiness());$('stop').disabled=!active()||transitioning;$('reset').disabled=active()||transitioning;$('speed').disabled=source!=='sim';$('runExperiment').disabled=$('batch').disabled=active();$('readyStatus').textContent=readiness()??'Siap memulai sesi. Keluaran lampu diterapkan pada simulator.';}
function assertConfig(){if(active())throw Error('Konfigurasi dikunci selama sesi aktif atau dijeda.');if(sessionId&&logger.pending.length)throw Error('Sinkronkan log sesi sebelum mengubah konfigurasi.');}
function reset(){
  if(active())return;if(sessionId&&logger.pending.length)return toast('Sinkronkan log sebelum reset.');
  generation++;abort?.abort();status='ready';sessionId='';fault=false;$('fault').checked=false;
  sim=source==='visual'?new VisualSimulation(config,mode):new Simulation(config,mode);recorded=source==='video'?new RecordedSimulator(config,mode,Number.isFinite(video.duration)?video.duration:7200):null;controller=recorded?.controller??sim.controller;observer=new Observer(config);lastOutput=-1;
  snapshot=null;detections=[];frames=[];latencies=[];published=0;activeWall=0;mediaTime=-1;frameId=0;accumulator=0;
  latestMeasurement=null;lastPublication=-1;lastLatencyFrame=-1;
  startupMs=null;
  decisionCursor=transitionCursor=historyCursor=0;hasObserved=false;lastQuality=null;lastError='';lastCapture=-Infinity;presentedTime=-1;
  video.pause();if(video.src)video.currentTime=0;$('start').textContent='▶ Mulai sesi';lock();render();
}
function fillConfig(roiOnly=false){
  if(!roiOnly)for(const key of ['seed','level','fixed','yellow','allred'])$(key).value=config[key];
  const i=+$('roiDir').value,pc=phaseConfig(config);
  $('roiPreview').textContent=JSON.stringify({ROI:config.rois[i],garis:config.exitLines[i],arah:config.exitDirections?.[i]??'outward'},null,2);
  $('exitDirection').value=config.exitDirections?.[i]??'outward';
  if(roiOnly)return;
  $('phaseJson').value=JSON.stringify({phases:pc.phases,phaseOrder:pc.order,conflictMap:pc.conflicts},null,2);
  $('fuzzyJson').value=JSON.stringify(config.fuzzy??null,null,2);
  $('measurementJson').value=JSON.stringify({gmin:config.gmin,gmax:config.gmax,roiLabels:config.roiLabels??DIRS,vehicleClasses:config.vehicleClasses??[2,3,5,7],confidence:config.confidence??.25,imgsz:config.imgsz??[736,1280],observation:config.observation??defaults().observation,snapshotMaxAge:config.snapshotMaxAge??2,recoverySnapshots:config.recoverySnapshots??3},null,2);
}
function updateSource(){
  $('recordedOutput').hidden=source!=='video';$('cameraTools').hidden=source!=='video';$('videoInputLabel').hidden=source!=='video';
  $('feedTitle').textContent=source==='video'?'Rekaman persimpangan':'Persimpangan 01';
  $('feedSub').textContent=source==='sim'?'REFERENSI TELEMETRI':source==='visual'?'RENDERER → YOLO26 → BYTETRACK → MAMDANI':'VIDEO LOKAL → YOLO26 → BYTETRACK';
  $('feedTag').textContent=source==='sim'?'TELEMETRI SIMULATOR':'PENGAMATAN VISUAL';
  const text=source==='sim'?['Referensi telemetri','Uji algoritma. Penerimaan visual memerlukan simulator visual atau video beranotasi.']:source==='visual'?['Umpan balik visual','Frame renderer diproses YOLO26 / ByteTrack. Hanya pengamatan visual masuk Mamdani; telemetri dipakai untuk metrik evaluasi. Cakupan detektor pada gambar prosedural belum diterima.']:['Rekaman CCTV → simulator','Pengamatan rekaman menentukan lampu dan gerak kendaraan sintetis pada simulator. Lalu lintas dalam rekaman tetap mengikuti kejadian aslinya.'];
  $('sourceNotice').innerHTML=`<strong>${text[0]}</strong><span>${text[1]}</span>`;$('chartTime').textContent=source==='video'?'Waktu media (detik)':'Waktu simulasi (detik)';lock();
}
async function createSession(){
  const pending=readiness();if(pending&&!transitioning)throw Error(pending);
  if(source==='video'&&!video.videoWidth)throw Error('Pilih rekaman video terlebih dahulu.');
  if(source==='video'&&hashPromise)await hashPromise;
  const id=crypto.randomUUID();
  await logger.start({session_id:id,config,source,mode,source_name:source==='video'?$('videoFile').files[0]?.name:source==='visual'?'procedural-visual-simulator':'telemetry-reference',source_sha256:source==='video'?sourceHash:null,metadata:{user_agent:navigator.userAgent,renderer:source==='visual'?'procedural-raster-v1; detector coverage unvalidated':null,output:source==='video'?'synthetic-simulator':'simulator',camera_profile_id:profileId,camera_profile_name:$('profileName').value.trim()||null,geometry_confirmed:source==='video'?$('geometryConfirmed').checked:null,recording:source==='video'?{width:video.videoWidth,height:video.videoHeight,duration_s:video.duration}:null}});
  sessionId=id;
  if(source!=='sim'){
    await logger.json(`/api/reset?session_id=${id}`,{method:'POST'});
    $('start').textContent='Menyiapkan model…';
    const prepared=await logger.json(`/api/warmup?session_id=${id}`,{method:'POST'});
    startupMs=prepared.startup_ms;
  }
  controller=recorded?.controller??sim.controller;observer=new Observer(config);
  record('lifecycle',{state:'started'});record('transition',{state:controller.state,phase:controller.phase,duration:controller.duration});
  if(logger.lastFailure){const failure=logger.lastFailure;await logger.end(sessionId,0,'mandatory-log-failure','failed').catch(()=>{});sessionId='';throw Error('Pencatatan sesi tidak tersedia: '+failure.message);}
}
$('start').onclick=async()=>{
  if(transitioning)return;if(edit)return toast('Simpan atau batalkan penandaan sebelum mulai.');
  if(!active()){const issue=readiness();if(issue)return toast(issue);}
  if(running()){generation++;abort?.abort();status='paused';video.pause();const t=source==='video'?video.currentTime:sim.time;if(source!=='sim'&&t>observer.lastTime)observer.invalidate(t,'jeda sesi');latestMeasurement=null;record('lifecycle',{state:'paused'});$('start').textContent='▶ Lanjutkan';lock();render();logger.flush().catch(()=>{});return;}
  transitioning=true;lock();try{
    if(status==='ended'||status==='failed'){reset();if(status!=='ready')throw Error('Log sesi sebelumnya belum sinkron.');}
    if(!sessionId)await createSession();if(source==='video')await video.play();
    if(status==='paused')record('lifecycle',{state:'resumed'});
    status='running';last=performance.now();$('start').textContent='Ⅱ Jeda';
  }catch(e){if(sessionId&&status==='ready'){status='failed';await logger.end(sessionId,0,'startup-failed: '+e.message,'failed').catch(()=>{});}$('start').textContent=status==='failed'?'▶ Sesi baru':'▶ Mulai sesi';toast('Sesi belum dimulai: '+e.message);}finally{transitioning=false;lock();render();}
};
async function end(reason='user',failed=false){
  if(transitioning||!active())return;transitioning=true;generation++;abort?.abort();status=failed?'failed':'ended';video.pause();collect();
  if(source!=='sim'&&observer.finish)record('track_summary',observer.finish());
  if(source==='visual')record('evaluation_truth',{metrics:sim.metrics(0),initial_queue:0,remaining:sim.cars.length,departed:sim.departed.length,scope:'ground truth for evaluation only'});
  if(recorded)record('simulator_summary',{...recorded.sample(),metrics:recorded.metrics(),seed:config.seed,level:config.level});
  record('lifecycle',{state:status,reason,performance:performanceReport()});$('start').textContent='▶ Sesi baru';lock();
  try{await logger.end(sessionId,controller.time,reason,status);}catch(e){toast('Sesi dihentikan; log menunggu sinkron: '+e.message);}finally{transitioning=false;lock();render();}
}
$('stop').onclick=()=>end();$('reset').onclick=reset;
$('fault').onchange=e=>{fault=e.target.checked;if(active())record('fault',{kind:'injected-source-failure',active:fault});if(fault){latestMeasurement=null;if(snapshot)snapshot={...snapshot,valid:false,reason:'gangguan sumber'};}};
$('source').onchange=e=>{$('videoInputLabel').hidden=e.target.value!=='video';};
function saveConfiguration(){try{
  assertConfig();const c=structuredClone(config);for(const k of ['seed','fixed','yellow','allred'])c[k]=Number($(k).value);c.level=$('level').value;
  Object.assign(c,JSON.parse($('phaseJson').value));const fuzzy=JSON.parse($('fuzzyJson').value);if(fuzzy)c.fuzzy=fuzzy;else delete c.fuzzy;
  Object.assign(c,JSON.parse($('measurementJson').value));
  c.exitDirections??=DIRS.map(()=>'outward');c.exitDirections[+$('roiDir').value]=$('exitDirection').value;config=validate(c);source=$('source').value;mode=$('controllerMode').value;
  if(source==='video'&&video.videoWidth&&$('geometryConfirmed').checked)config.cameraGeometry={width:video.videoWidth,height:video.videoHeight,profile_id:profileId};
  configDirty=false;localStorage.setItem('simpang-config',JSON.stringify(config));reset();fillConfig();updateSource();toast('Konfigurasi disimpan.');return true;
}catch(e){toast(e.message);return false;}}
$('saveConfig').onclick=saveConfiguration;
$('downloadConfig').onclick=()=>download('konfigurasi-simpang.json',config);
$('importConfig').onchange=async e=>{try{assertConfig();config=validate(JSON.parse(await e.target.files[0].text()));configDirty=false;$('geometryConfirmed').checked=false;localStorage.setItem('simpang-config',JSON.stringify(config));fillConfig();reset();}catch(e){toast(e.message);}};
$('videoFile').onchange=e=>{
  if(active())return;const file=e.target.files[0];if(!file)return;if(videoUrl)URL.revokeObjectURL(videoUrl);sourceHash=null;hashProgress=0;const token=++fileGeneration;let loaded=false;
  $('geometryConfirmed').checked=false;
  hashPromise=fileHash.digest(file,progress=>{if(token===fileGeneration){hashProgress=progress;showSourceInfo();lock();}}).then(hash=>{if(token===fileGeneration){sourceHash=hash;showSourceInfo();lock();}});
  hashPromise.catch(error=>{if(error.name!=='AbortError'&&token===fileGeneration)toast(error.message);});
  videoUrl=URL.createObjectURL(file);video.src=videoUrl;video.onloadeddata=()=>{if(loaded||token!==fileGeneration)return;loaded=true;source='video';$('source').value='video';configDirty=false;reset();updateSource();showSourceInfo();toast('Rekaman dimuat. Periksa profil dan konfirmasikan ROI sebelum mulai.');};showSourceInfo();lock();
};
video.onerror=()=>{if(active())record('fault',{kind:'video-decode-error'});lastError='video-decode-error';latestMeasurement=null;if(snapshot)snapshot.valid=false;toast('Format video tidak dapat dibaca browser. Pilih MP4 H.264 atau WebM VP8/VP9.');};
video.onstalled=()=>{if(running())record('fault',{kind:'video-stalled'});};video.onwaiting=()=>{if(running())record('fault',{kind:'video-buffering'});};video.onended=()=>end('end-of-video');
if(video.requestVideoFrameCallback){const nextFrame=(now,meta)=>{presentedTime=meta.mediaTime;video.requestVideoFrameCallback(nextFrame);};video.requestVideoFrameCallback(nextFrame);}
$('roiDir').onchange=()=>fillConfig(true);
function startEdit(type){if(active())return;if(source!=='video'||!video.videoWidth)return toast('Pilih video terlebih dahulu.');edit=type;points=[];$('roiHint').hidden=false;$('roiHint').textContent=type==='roi'?'Klik minimal 3 titik, lalu Simpan titik di Konfigurasi.':'Klik awal dan akhir garis. Pilih arah perlintasan di Konfigurasi.';navigate('monitor');}
$('editRoi').onclick=()=>startEdit('roi');$('editLine').onclick=()=>startEdit('line');$('cancelRoi').onclick=()=>{edit=null;points=[];$('roiHint').hidden=true;};
scene.onclick=e=>{if(!edit)return;const r=scene.getBoundingClientRect();if(edit==='line'&&points.length>=2)points=[];points.push([Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))]);};
$('saveRoi').onclick=()=>{try{assertConfig();if(!edit||points.length<(edit==='roi'?3:2))throw Error('Titik belum lengkap.');const c=structuredClone(config),i=+$('roiDir').value;if(edit==='roi')c.rois[i]=points;else c.exitLines[i]=points;c.exitDirections??=DIRS.map(()=>'outward');c.exitDirections[i]=$('exitDirection').value;config=validate(c);configDirty=false;$('geometryConfirmed').checked=false;localStorage.setItem('simpang-config',JSON.stringify(config));edit=null;points=[];$('roiHint').hidden=true;reset();fillConfig();}catch(e){toast(e.message);}};
function currentSnapshot(){if(!snapshot)return null;const age=Math.max(0,controller.time-snapshot.time),valid=!fault&&snapshot.valid&&age<=(config.snapshotMaxAge??2);return{...snapshot,age,valid,rows:snapshot.rows.map(r=>({...r,age,valid:valid&&r.valid})),reason:fault?'gangguan sumber':age>(config.snapshotMaxAge??2)?'snapshot kedaluwarsa':snapshot.reason};}
function publishSnapshot(){
  if(source==='sim'||controller.time-lastPublication<.999)return;lastPublication=controller.time;
  const m=latestMeasurement,age=m?Math.max(0,controller.time-m.time):null,valid=!!m&&m.valid&&!fault&&age<=(config.snapshotMaxAge??2);
  const reason=valid?null:fault?'gangguan sumber':lastError||(!m?'data belum tersedia':'snapshot kedaluwarsa');
  const rows=(m?.rows??DIRS.map((name,roi)=>({roi,name}))).map(r=>({...r,time:m?.time??controller.time,media_time:m?.media_time??null,age,valid:valid&&r.valid!==false,q:valid?r.q:null,w:valid?r.w:null,avg:valid?r.avg:null,reason}));
  const phases=(m?.phases??phaseConfig(config).phases.map((p,phase)=>({phase,name:p.name}))).map(p=>({...p,age,valid:valid&&p.valid!==false,q:valid?p.q:null,w:valid?p.w:null,avg:valid?p.avg:null,reason}));
  snapshot={...m,time:m?.time??controller.time,published_at:controller.time,age,valid,reason,rows,phases,media_time:m?.media_time??null};
  if(m&&m.frame_id!==lastLatencyFrame){snapshot.latency_ms=performance.now()-m.capture_wall_ms;latencies.push(snapshot.latency_ms);lastLatencyFrame=m.frame_id;}
  frames.push(snapshot);if(frames.length>1200)frames.shift();record('snapshot',snapshot,snapshot.media_time===null?{}:{media_time:snapshot.media_time});
}
function collect(){
  if(!sessionId)return;
  for(;decisionCursor<controller.decisions.length;decisionCursor++)record('decision',controller.decisions[decisionCursor]);
  for(;transitionCursor<controller.events.length;transitionCursor++)record('transition',controller.events[transitionCursor]);
  if(source==='sim')for(;historyCursor<sim.snapshots.length;historyCursor++)record('snapshot',sim.snapshots[historyCursor]);
  if(recorded&&controller.time-lastOutput>=.999){record('simulator_output',recorded.sample());lastOutput=controller.time;}
}
async function processFrame(now){
  if(busy||!running()||source==='sim'||fault||now-lastCapture<70)return;if(source==='video'&&!video.videoWidth)return;
  const t=source==='video'?(video.requestVideoFrameCallback?presentedTime:video.currentTime):sim.time;if(t<0||t<=Math.max(mediaTime,observer.lastTime))return;
  busy=true;lastCapture=now;const token=generation,id=++frameId,capturedAt=controller.time,started=performance.now(),requestAbort=new AbortController();abort=requestAbort;
  const timeout=setTimeout(()=>requestAbort.abort(),30000);
  try{
    let width,height;if(source==='visual'){sim.render(capture);width=1280;height=720;}else{width=video.videoWidth;height=video.videoHeight;const scale=Math.min(1,1280/width,720/height);capture.width=Math.round(width*scale);capture.height=Math.round(height*scale);capture.getContext('2d').drawImage(video,0,0,capture.width,capture.height);}
    const blob=await new Promise((resolve,reject)=>capture.toBlob(b=>b?resolve(b):reject(Error('Encode frame gagal')),'image/jpeg',.85)),body=new FormData();body.append('frame',blob,'frame.jpg');
    for(const [k,v]of Object.entries({session_id:sessionId,media_time:t,frame_id:id,original_width:width,original_height:height}))body.append(k,String(v));
    const response=await fetch('/api/track',{method:'POST',body,signal:requestAbort.signal});if(!response.ok){const x=await response.json();throw Error(typeof x.detail==='string'?x.detail:'Inferensi gagal');}
    const out=await response.json();if(!running()||token!==generation)return;if(out.valid===false)throw Error(out.reason||'Observasi tidak valid');
    const measured=observer.update(t,out.detections,{frameId:id,sourceId:sourceHash??source});detections=out.detections;mediaTime=t;
    observed.width=capture.width;observed.height=capture.height;observed.getContext('2d').drawImage(capture,0,0);hasObserved=true;
    const entry={...measured,time:capturedAt,media_time:t,source_id:sourceHash??source,frame_id:id,age:Math.max(0,controller.time-capturedAt),detections,capture_wall_ms:started,latency_ms:performance.now()-started,original_width:width,original_height:height,frame_width:capture.width,frame_height:capture.height,metadata:out.metadata};
    published++;lastError='';record('track_measurement',entry,{media_time:t});
    latestMeasurement=entry;
    $('dataHealth').title=JSON.stringify(out.metadata);
  }catch(e){if(token===generation&&running()){lastError=e.name==='AbortError'?'inference-timeout':e.message;latestMeasurement=null;if(t>observer.lastTime)observer.invalidate(t,lastError);if(snapshot)snapshot={...snapshot,valid:false,reason:lastError};record('fault',{kind:'inference-error',message:lastError,media_time:t,frame_id:id});if(lastError.startsWith('MANDATORY_LOG_FAILURE'))end(lastError,true);if(now-(processFrame.lastToast??-Infinity)>5000){toast('Pipeline: '+lastError);processFrame.lastToast=now;}}}
  finally{clearTimeout(timeout);busy=false;if(abort===requestAbort)abort=null;}
}
function performanceReport(){const a=[...latencies].sort((a,b)=>a-b);return{processed_frames:published,effective_fps:activeWall?published/activeWall:0,active_wall_s:activeWall,model_startup_ms:startupMs,frame_to_snapshot_p95_ms:a.length?a[Math.ceil(a.length*.95)-1]:null,frame_width:observed.width,frame_height:observed.height,scope:'Capture, encode, HTTP, inference, Observer and snapshot publication; preparation before playback reported separately; log acknowledgement excluded',acceptance:'Representative annotated video required'};}
function loop(now){
  const dt=Math.max(0,(now-last)/1000);last=now;
  try{if(running()){activeWall+=dt;accumulator+=dt*(source==='sim'?Number($('speed').value):1);let steps=0;
    while(accumulator>=.1&&steps++<200){if(source==='sim'){sim.tick(.1,!fault);snapshot=sim.snapshot;}else if(source==='visual')sim.step(.1,currentSnapshot());else recorded.tick(.1,currentSnapshot());publishSnapshot();accumulator-=.1;}
    if(source!=='sim')processFrame(now);collect();const quality=source==='sim'?!fault:!!currentSnapshot()?.valid;
    if(quality!==lastQuality){record('quality',{valid:quality,reason:quality?'pengamatan pulih':currentSnapshot()?.reason??'menunggu pengamatan'});lastQuality=quality;}
  }
  if(now-lastDraw>150){render();lastDraw=now;}}
  catch(error){if(active())end('simulator-or-dashboard-error: '+error.message,true);toast(error.message);}
  requestAnimationFrame(loop);
}
setInterval(()=>{collect();if(logger.pending.length)logger.flush().catch(()=>{});},1000);logger.flush().catch(()=>{});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&running())$('start').click();});
window.addEventListener('beforeunload',e=>{if(active()||logger.pending.length){e.preventDefault();e.returnValue='';}});
async function exportSession(format='json'){
  if(!sessionId)return toast('Belum ada sesi.');collect();if(active())record('performance',performanceReport());try{await logger.flush();const response=await fetch(`/api/sessions/${sessionId}/export?format=${format}`);if(!response.ok)throw Error('Ekspor gagal');download(`sesi-${sessionId}.${format}`,await response.text(),format==='csv'?'text/csv':'application/json');}catch(e){toast(e.message+'; sinkronkan log lalu ekspor ulang.');}
}
$('export').onclick=()=>exportSession();$('exportCsv').onclick=()=>exportSession('csv');$('syncLogs').onclick=()=>logger.flush().catch(e=>toast(e.message));
$('refreshSessions').onclick=async()=>{try{const out=await logger.json('/api/sessions'),items=Array.isArray(out)?out:out.sessions??[];$('savedSessions').replaceChildren();for(const s of items){const p=document.createElement('p');p.textContent=`${s.session_id} · ${s.source} · ${s.status} `;for(const format of ['json','csv']){const a=document.createElement('a');a.href=`/api/sessions/${s.session_id}/export?format=${format}`;a.download=`sesi-${s.session_id}.${format}`;a.textContent=` ${format.toUpperCase()} `;p.append(a);}$('savedSessions').append(p);}}catch(e){toast(e.message);}};
function render(){
  if(!controller)return;const pc=phaseConfig(config),phase=pc.phases[controller.phase],next=controller.nextPhase,rois=controller.activeRois;
  const rows=source==='sim'?sim.rows:snapshot?.rows??DIRS.map(()=>({q:null,w:null,avg:null})),healthy=source==='sim'?!fault:!!currentSnapshot()?.valid;
  $('totalQ').textContent=healthy?rows.reduce((s,r)=>s+(r.q??0),0):'—';$('maxW').innerHTML=healthy?`${Math.max(...rows.map(r=>r.w??0)).toFixed(1)} <em>dtk</em>`:'—';$('served').textContent=source==='sim'?sim.departed.length:observer.counts.reduce((s,v)=>s+v,0);
  $('controlMode').textContent=mode==='fixed'?'Tetap':controller.fallback?'Cadangan':'Adaptif';$('modePill').textContent=$('controlMode').textContent.toUpperCase();$('dataHealth').textContent=healthy?`${status==='paused'?'Dijeda · ':''}${rows.some(r=>r.estimated)?'Estimasi track hilang':'Snapshot sehat'} · ${Math.max(0,controller.time-(snapshot?.time??0)).toFixed(1)} dtk`:`Data tidak valid · ${lastError||currentSnapshot()?.reason||'menunggu pengamatan'}`;
  $('phaseName').textContent=`${controller.phase+1} / ${phase.name}`;$('stateName').textContent=controller.state;$('remaining').textContent=Math.max(0,Math.ceil(controller.remaining));const clock=source==='video'?Math.max(0,mediaTime):sim.time;$('clock').textContent=`${String(Math.floor(clock/60)).padStart(2,'0')}:${(clock%60).toFixed(1).padStart(4,'0')}`;
  $('runBadge').textContent={ready:'SIAP',running:'BERJALAN',paused:'DIJEDA',ended:'SELESAI',failed:'GAGAL'}[status];$('phaseOrder').innerHTML=pc.order.map(i=>`<span class="${i===controller.phase?'active':''}">${escape(pc.phases[i].name)}</span>`).join('');$('nextPhase').textContent=pc.phases[next].name+' →';$('transitionHint').textContent=`Kuning ${config.yellow} dtk → semua merah ${config.allred} dtk. Keputusan dibekukan saat hijau berakhir.`;
  ['Red','Yellow','Green'].forEach((k,i)=>$('light'+k).classList.toggle('on',controller.state===['SEMUA MERAH','KUNING','HIJAU'][i]));
  $('directionRows').innerHTML=rows.map((r,i)=>{const state=rois.includes(i)?controller.state:'MERAH';return`<tr><td>${escape(config.roiLabels?.[i]??DIRS[i])}</td><td>${healthy?r.q??'—':'—'}${r.estimated?' ≈':''}</td><td>${healthy&&r.w!=null?r.w.toFixed(1):'—'} dtk</td><td>${healthy&&r.avg!=null?r.avg.toFixed(1):'—'} dtk</td><td><span class="status ${state.toLowerCase()}">${state}</span></td></tr>`;}).join('');
  const d=controller.decisions.at(-1);$('decision').innerHTML=d?`<div class="decisionstats"><div><small>Q ${escape(pc.phases[d.to]?.name)}</small><strong>${d.q??'—'}</strong></div><div><small>TUNGGU MAKS.</small><strong>${d.w?.toFixed(1)??'—'} dtk</strong></div></div><div class="decisionoutput"><span>${d.centroid!=null?'Centroid '+d.centroid.toFixed(2):escape(d.mode)}</span><b>${d.green.toFixed(1)} dtk hijau</b></div><p>${escape(d.reason??'Min–max · centroid 0,1 dtk · berlaku setelah transisi')}</p>`:'<p class="muted">Keputusan pertama dihitung saat hijau awal berakhir.</p>';
  const perf=performanceReport();$('performance').textContent=source==='sim'?'Sumber: telemetri referensi':`${source} · ${perf.effective_fps.toFixed(2)} FPS efektif · p95 ${perf.frame_to_snapshot_p95_ms?.toFixed(0)??'—'} ms · ${published} frame · media ${mediaTime.toFixed(2)} s`;
  $('footerSession').textContent=sessionId?'Sesi '+sessionId.slice(0,8)+' · '+status:'Belum ada sesi aktif';$('sessionInfo').textContent=sessionId?`${sessionId} · ${source} · ${controller.decisions.length} keputusan · ${logger.pending.length} log menunggu`:'Belum ada sesi.';
  $('logRows').innerHTML=controller.decisions.slice(-100).reverse().map(d=>`<tr><td>${d.time.toFixed(1)}</td><td>${escape(pc.phases[d.to]?.name)}</td><td>${d.q??'—'} / ${d.w?.toFixed(1)??'—'}</td><td>${d.centroid?.toFixed(2)??'—'}</td><td>${d.green.toFixed(1)}</td><td>${escape(d.mode)} · ${escape(d.reason)}</td></tr>`).join('');draw();chart();drawOutput();lock();
}
const palette=['#c5e590','#7fbab6','#e1b88b','#a8a3d1'];
function polygon(poly,color,fill=true){ctx.beginPath();poly.forEach((p,i)=>i?ctx.lineTo(p[0]*scene.width,p[1]*scene.height):ctx.moveTo(p[0]*scene.width,p[1]*scene.height));if(fill)ctx.closePath();ctx.strokeStyle=color;ctx.lineWidth=2;ctx.stroke();if(fill){ctx.globalAlpha=.08;ctx.fillStyle=color;ctx.fill();ctx.globalAlpha=1;}}
function draw(){
  if(source==='video'&&!video.videoWidth&&!hasObserved){ctx.fillStyle='#20382d';ctx.fillRect(0,0,scene.width,scene.height);ctx.fillStyle='#c7d6d0';ctx.font='24px Arial';ctx.fillText('Pilih rekaman CCTV pada Konfigurasi',30,80);return;}
  if(source==='sim'||source==='visual'&&!hasObserved){const f=renderSimulationFrame(sim);scene.width=f.width;scene.height=f.height;const image=ctx.createImageData(f.width,f.height);image.data.set(f.data);ctx.putImageData(image,0,0);}
  else if(source==='video'&&video.videoWidth||hasObserved){const image=hasObserved?observed:video;scene.width=hasObserved?observed.width:video.videoWidth;scene.height=hasObserved?observed.height:video.videoHeight;ctx.drawImage(image,0,0,scene.width,scene.height);}
  scene.parentElement.style.aspectRatio=`${scene.width}/${scene.height}`;
  if(source!=='sim'){config.rois.forEach((poly,i)=>{polygon(poly,palette[i]);polygon(config.exitLines[i],palette[i],false);});for(const d of detections){const[x,y,x2,y2]=d.box;ctx.strokeStyle='#c9f093';ctx.strokeRect(x*scene.width,y*scene.height,(x2-x)*scene.width,(y2-y)*scene.height);ctx.fillStyle='#e4ffbe';ctx.font='16px monospace';ctx.fillText(`${d.label??d.class_id} #${d.id} ${Number(d.confidence??0).toFixed(2)}`,x*scene.width,Math.max(18,y*scene.height-5));}}
  if(edit&&points.length)polygon(points,'#ffdf70',edit==='roi');
}
function chart(){const h=(source==='sim'?sim.history:frames.map(s=>({time:s.media_time,q:s.valid?s.rows.reduce((a,r)=>a+(r.q??0),0):null,w:s.valid?Math.max(...s.rows.map(r=>r.w??0)):null}))).slice(-120);for(const [id,key,label]of [['chart','q','Antrean (kendaraan)'],['waitChart','w','Tunggu maksimum (detik)']]){const canvas=$(id),g=canvas.getContext('2d'),max=Math.max(5,...h.map(x=>x[key]??0));g.clearRect(0,0,canvas.width,canvas.height);g.fillStyle='#69816e';g.font='12px sans-serif';g.fillText(`${label} · maks. ${max.toFixed(1)}`,20,15);g.strokeStyle=key==='q'?'#6c9b50':'#ad845e';g.lineWidth=2;g.beginPath();let connected=false;h.forEach((r,i)=>{if(r[key]==null){connected=false;return;}const x=20+i*(canvas.width-40)/Math.max(1,h.length-1),y=160-r[key]/max*130;if(connected)g.lineTo(x,y);else g.moveTo(x,y);connected=true;});g.stroke();}}
async function experiments(batch){if(active())return toast('Akhiri sesi sebelum eksperimen.');$('runExperiment').disabled=$('batch').disabled=true;try{const results=[];for(const level of batch?['ringan','sedang','padat']:[config.level])for(const seed of batch?[1,2,3,4,5]:[config.seed]){await new Promise(resolve=>setTimeout(resolve,20));results.push(paired({...config,level,seed,warmup:300,horizon:1800}));$('experimentResult').textContent=`Selesai ${results.length} / ${batch?15:1}`;}experiment={created_at:new Date().toISOString(),validation:'Referensi telemetri; bukan penerimaan visual',results};$('experimentResult').innerHTML='<pre>'+escape(JSON.stringify(results.map(r=>({level:r.scenario.level,seed:r.scenario.seed,adaptive:r.adaptive,fixed:r.fixed,improvement:r.improvement})),null,2))+'</pre>';$('exportExperiment').disabled=false;}catch(e){toast(e.message);}finally{$('runExperiment').disabled=$('batch').disabled=false;}}
$('runExperiment').onclick=()=>experiments(false);$('batch').onclick=()=>experiments(true);$('exportExperiment').onclick=()=>{if(experiment)download('eksperimen-berpasangan.json',experiment);};
function drawOutput(){
  if(!recorded)return;const canvas=$('signalScene'),g=canvas.getContext('2d'),frame=renderSimulationFrame(recorded),image=g.createImageData(frame.width,frame.height);image.data.set(frame.data);g.putImageData(image,0,0);
  canvas.dataset.time=recorded.time.toFixed(1);canvas.dataset.phase=controller.phase;canvas.dataset.state=controller.state;canvas.dataset.vehicles=recorded.cars.length;
  $('outputState').textContent=controller.state;
  $('outputSummary').textContent=`Waktu simulator ${recorded.time.toFixed(1)} dtk · ${recorded.cars.length} kendaraan sintetis aktif · ${recorded.departed.length} keluar · fase ${controller.phaseName} · arus ${config.level} · seed ${config.seed}`;
}
function showSourceInfo(){const file=$('videoFile').files[0];$('sourceStatus').textContent=file?`${file.name} · ${(file.size/1024/1024).toFixed(1)} MB${video.videoWidth?' · '+video.videoWidth+' × '+video.videoHeight+' · '+video.duration.toFixed(1)+' dtk':''} · ${sourceHash?'checksum siap':'checksum '+Math.round(hashProgress*100)+'%'}`:'Belum ada rekaman.';}
async function refreshBackend(){try{const r=await fetch('/api/health',{signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error();const h=await r.json(),[major,minor]=String(h.version??'0.0').split('.').map(Number);backendOnline=h.local_backend===true&&(major>=1||major===0&&minor>=3);$('backendStatus').textContent=backendOnline?`Backend lokal · ${h.model_device==='not-loaded'?'model siap dimuat':h.model_device}`:'Backend versi lama; jalankan ulang start.cmd';}catch{backendOnline=false;$('backendStatus').textContent='Backend tidak terhubung';}$('backendStatus').classList.toggle('offline',!backendOnline);lock();}
async function refreshProfiles(){try{const result=await logger.json('/api/profiles'),select=$('cameraProfile'),previous=profileId;select.replaceChildren(new Option('Profil baru',''));for(const p of result.profiles)select.add(new Option(p.name,p.profile_id));select.value=previous??'';}catch(error){toast('Profil: '+error.message);}}
$('refreshProfiles').onclick=refreshProfiles;
$('cameraProfile').onchange=()=>{if(!$('cameraProfile').value){profileId=null;$('profileName').value='';delete config.cameraGeometry;$('geometryConfirmed').checked=false;lock();}};
$('geometryConfirmed').onchange=()=>lock();
$('loadProfile').onclick=async()=>{try{assertConfig();const id=$('cameraProfile').value;if(!id)throw Error('Pilih profil kamera tersimpan.');const p=await logger.json(`/api/profiles/${id}`);if(video.videoWidth&&Math.abs(p.source_width/p.source_height-video.videoWidth/video.videoHeight)>.01)throw Error('Rasio gambar profil berbeda. Pilih Profil baru dan tandai ROI untuk rekaman ini.');config=validate(p.config);config.cameraGeometry={width:p.source_width,height:p.source_height,profile_id:id};profileId=id;$('profileName').value=p.name;$('geometryConfirmed').checked=false;configDirty=false;fillConfig();reset();toast('Profil dimuat. Periksa dan konfirmasikan posisi ROI pada rekaman.');}catch(error){toast(error.message);}};
$('saveProfile').onclick=async()=>{try{assertConfig();if(!video.videoWidth)throw Error('Pilih rekaman sebelum menyimpan profil.');if(!$('geometryConfirmed').checked)throw Error('Periksa dan konfirmasikan ROI terlebih dahulu.');if(!saveConfiguration())return;const name=$('profileName').value.trim();if(!name)throw Error('Isi nama profil kamera.');const p=await logger.json(profileId?`/api/profiles/${profileId}`:'/api/profiles',{method:profileId?'PUT':'POST',body:JSON.stringify({name,config,source_width:video.videoWidth,source_height:video.videoHeight})});profileId=p.profile_id;config.cameraGeometry.profile_id=profileId;await refreshProfiles();toast('Profil kamera tersimpan di backend lokal.');}catch(error){toast(error.message);}};
for(const id of ['fixed','yellow','allred','seed','level','source','controllerMode','phaseJson','fuzzyJson','measurementJson'])$(id).addEventListener('input',()=>{if(!active()){configDirty=true;lock();}});
$('source').value=source;fillConfig();reset();updateSource();refreshBackend();refreshProfiles();setInterval(refreshBackend,5000);requestAnimationFrame(loop);
