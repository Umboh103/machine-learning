import {EdgeSimulator} from './edge-controller.js';
import {renderSimulationFrame} from './visual-simulator.js';

const $=id=>document.getElementById(id);
let output=null,sessionId=null,token=null,state='ready',cursor=0,leaseUntil=0;
let last=performance.now(),accumulator=0,lastDraw=0,queued=false,io=Promise.resolve();
const enqueue=fn=>{const result=io.catch(()=>{}).then(fn);io=result;return result;};
async function api(path,data){
  const response=await fetch(path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(1800)});
  if(!response.ok){const body=await response.json().catch(()=>({})),error=Error(body.detail??`HTTP ${response.status}`);error.status=response.status;throw error;}
  return response.json();
}
function message(text){$('message').textContent=text;}
function fail(error){
  if(output){output.controller.deadline=-Infinity;output.controller.quality(performance.now());}
  message(error.message);
  if(error.status||performance.now()>leaseUntil){state='failed';$('journal').textContent='Sesi berhenti: koneksi atau jurnal gagal';}
  render();
}
async function sessions(){
  const result=await api('/api/edge/sessions'),selected=$('sessions').value;
  const items=result.sessions.filter(s=>['running','paused'].includes(s.status));
  $('sessions').replaceChildren();
  for(const item of items){const option=document.createElement('option');option.value=item.session_id;option.textContent=`${item.source_name} · ${item.session_id.slice(0,8)} · ${item.status}`;$('sessions').append(option);}
  if(!items.length){const option=document.createElement('option');option.value='';option.textContent='Belum ada sesi agen Python';$('sessions').append(option);}
  if(items.some(s=>s.session_id===selected))$('sessions').value=selected;
}
async function feedback(action='heartbeat'){
  const events=output.controller.events.slice(cursor);
  await api(`/api/edge/sessions/${sessionId}/feedback`,{token,action,time:output.controller.time,events,event_start:cursor,snapshot:output.sample()});
  cursor+=events.length;leaseUntil=performance.now()+4500;$('journal').textContent='Jurnal tersimpan · '+new Date().toLocaleTimeString('id-ID');
}
async function sync(){
  const sent=performance.now(),result=await api(`/api/edge/sessions/${sessionId}`);
  if(result.proposal)output.controller.receive(result.proposal,performance.now(),result.server_utc_ms+(performance.now()-sent));
  await feedback();
}
$('refresh').onclick=()=>sessions().catch(error=>message(error.message));
$('connect').onclick=()=>enqueue(async()=>{
  if(['running','paused'].includes(state))return;
  const sid=$('sessions').value;if(!sid)return message('Jalankan agen Python terlebih dahulu.');
  $('connect').disabled=true;
  try{
    const config=await api(`/api/edge/sessions/${sid}`);
    const candidate=new EdgeSimulator(config.config,config.config_sha256,sid);
    const claim=await api(`/api/edge/sessions/${sid}/claim`,{consumer_id:crypto.randomUUID()});
    output=candidate;sessionId=sid;token=claim.token;cursor=0;state='running';leaseUntil=performance.now()+4500;
    accumulator=0;last=performance.now();$('config').textContent=JSON.stringify(config.config,null,2);
    for(const format of ['json','csv']){$(format).href=`/api/sessions/${sid}/export?format=${format}`;$(format).hidden=false;}
    message('Terhubung. Konfigurasi dikunci untuk sesi ini.');
    await sync();
  }catch(error){fail(error);}finally{render();}
});
async function control(action){
  if(!['running','paused'].includes(state))return;
  if(action!=='resume')state='paused';
  try{
    await feedback(action);
    state=action==='resume'?'running':action==='end'?'ended':'paused';
    if(action==='resume'){last=performance.now();accumulator=0;}
  }catch(error){fail(error);}
  render();
}
$('pause').onclick=()=>enqueue(()=>control(state==='running'?'pause':'resume'));
$('end').onclick=()=>enqueue(()=>control('end'));
document.addEventListener('visibilitychange',()=>{if(document.hidden&&state==='running')enqueue(()=>control('pause'));});
setInterval(()=>{
  if(queued)return;queued=true;
  enqueue(async()=>{try{if(['running','paused'].includes(state))await sync();else if(!sessionId)await sessions();}catch(error){fail(error);}finally{queued=false;}});
},500);
function render(){
  const active=['running','paused'].includes(state),c=output?.controller;
  $('status').textContent={ready:'BELUM TERHUBUNG',running:'BERJALAN',paused:'DIJEDA',ended:'SELESAI',failed:'GAGAL'}[state];
  $('connect').disabled=active;$('sessions').disabled=active;$('pause').disabled=$('end').disabled=!active;
  $('pause').textContent=state==='paused'?'Lanjutkan':'Jeda';
  if(!c)return;
  if(active)c.quality(performance.now());
  $('phase').textContent=`${c.phase+1} / ${c.phaseName}`;$('signal').textContent=c.state;$('remaining').textContent=Math.max(0,c.remaining).toFixed(1);
  $('clock').textContent=c.time.toFixed(1)+' detik';$('quality').textContent=`${c.fallback?'CADANGAN':'PRESENCE ADAPTIF'} · ${c.reason} · seq ${c.seq}`;
  const decision=c.decisions.at(-1),applied=c.events.findLast(event=>event.type==='application_ack')?.data;
  if(c.state!=='HIJAU'&&decision)$('decision').textContent=`Rencana ${decision.time.toFixed(1)} s: fase ${decision.to+1}, ${decision.green.toFixed(1)} s (${decision.mode}). Menunggu clearance dan pemeriksaan sumber.`;
  else if(applied)$('decision').textContent=`Diterapkan ${applied.applied_at.toFixed(1)} s: fase ${applied.to+1}, ${applied.green.toFixed(1)} s (${applied.mode}). ${applied.reason}`;
  else $('decision').textContent='Hijau awal memakai durasi cadangan konfigurasi.';
  $('summary').textContent=`${output.world.cars.length} kendaraan sintetis aktif · ${output.world.departed.length} keluar`;
  $('rows').replaceChildren();
  const valid=c.fresh(performance.now());
  c.config.phase_names.forEach((name,i)=>{const row=document.createElement('tr'),observation=c.latest?.rows?.[i];for(const value of [name,valid?observation?.vehicles??'—':'—',valid?observation?.weighted_presence??'—':'—',valid?`${c.latest.green_s[i]} s`:'—']){const cell=document.createElement('td');cell.textContent=String(value);row.append(cell);}$('rows').append(row);});
  const frame=renderSimulationFrame(output.world),canvas=$('scene'),ctx=canvas.getContext('2d');
  canvas.width=frame.width;canvas.height=frame.height;const image=ctx.createImageData(frame.width,frame.height);image.data.set(frame.data);ctx.putImageData(image,0,0);
}
function animate(now){
  const dt=(now-last)/1000;last=now;
  if(state==='running'){
    if(now>leaseUntil)fail(Error('Koneksi simulator kedaluwarsa; mulai sesi baru.'));
    else if(dt>1){state='paused';enqueue(async()=>{try{await feedback('pause');message('Simulator dijeda karena tab atau perangkat tertunda.');}catch(error){fail(error);}});}
    else{accumulator+=dt;while(accumulator>=.05){output.tick(.05,now);accumulator-=.05;}}
  }
  if(now-lastDraw>150){render();lastDraw=now;}requestAnimationFrame(animate);
}
sessions().catch(error=>message(error.message));render();requestAnimationFrame(animate);
