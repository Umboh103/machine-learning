import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
let playwright;try{playwright=await import('playwright');}catch{playwright=await import('../../../.tooling/node_modules/playwright/index.mjs');}
const base=process.env.SIMPANG_URL??'http://127.0.0.1:8020';
const browser=await playwright.chromium.launch({headless:true,executablePath:process.env.SIMPANG_CHROMIUM});
const context=await browser.newContext({viewport:{width:1440,height:1100}}),page=await context.newPage();
const errors=[],checks=[];page.on('pageerror',error=>errors.push(error.message));
const config={...JSON.parse(await readFile('examples/edge_density/config.example.json','utf8')),green_min_s:1,green_max_s:6,fallback_green_s:1,yellow_s:.3,all_red_s:.2};
const request=async(path,data)=>{const response=await fetch(base+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});assert(response.ok,`${path}: ${response.status} ${await response.clone().text()}`);return response.json();};
async function waitUntil(fn,timeout=12000){const until=Date.now()+timeout;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,250));}throw Error('Condition timeout');}
let timer=null,agent=null;
try{
  await page.goto(base+'/edge.html');
  const start=await request('/api/edge/sessions',{config,source_name:'Injected protocol fixture; not visual evidence'}),sid=start.session_id;
  let seq=0;
  const publish=async()=>{
    const now=Date.now(),counts=[1,2,1,0];
    seq++;
    await request(`/api/edge/sessions/${sid}/proposals`,{schema:'traffic-plan-proposal-v1',session_id:sid,intersection_id:config.intersection_id,seq,frame_id:seq,source_epoch:1,config_sha256:start.config_sha256,created_at_utc_ms:now,valid_until_utc_ms:now+2000,valid:true,phase_order:config.phase_order,green_min_s:1,green_max_s:6,fallback_green_s:1,green_s:counts.map(n=>Math.min(6,1+2*n)),rows:counts.map((n,phase)=>({phase,vehicles:n,by_class:n?{'2':n}:{},weighted_presence:n})),output_scope:'simulator-proposals-only'});
  };
  await publish();timer=setInterval(()=>publish().catch(error=>errors.push(error.message)),1000);
  await page.locator('#refresh').click();await page.locator('#sessions').selectOption(sid);await page.locator('#connect').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='BERJALAN');
  await waitUntil(async()=>{const data=await request(`/api/sessions/${sid}/export`);return data.events.some(e=>e.type==='application_ack'&&e.data.mode==='presence-adaptif');});
  const conflict=await fetch(`${base}/api/edge/sessions/${sid}/claim`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({consumer_id:'second-tab'})});assert.equal(conflict.status,409);
  assert(await page.locator('#sessions').isDisabled());
  checks.push({name:'One consumer, locked config, distinct source observations and adaptive application ACK',pass:true,session_id:sid});
  await page.locator('#pause').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='DIJEDA');
  const clock=await page.locator('#clock').textContent(),remaining=await page.locator('#remaining').textContent();
  await page.waitForTimeout(850);assert.equal(await page.locator('#clock').textContent(),clock);assert.equal(await page.locator('#remaining').textContent(),remaining);
  await page.locator('#pause').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='BERJALAN');
  checks.push({name:'Pause freezes simulation and remaining phase time; resume works',pass:true});
  clearInterval(timer);timer=null;
  await page.waitForFunction(()=>document.querySelector('#quality').textContent.startsWith('CADANGAN'),null,{timeout:6000});
  checks.push({name:'Producer silence expires observation and activates fallback',pass:true});
  await page.locator('#end').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='SELESAI');
  const exported=await request(`/api/sessions/${sid}/export`);
  assert.equal(exported.status,'ended');assert(exported.events.some(e=>e.type==='transition'&&e.data.state==='KUNING'));assert(exported.events.some(e=>e.type==='transition'&&e.data.state==='SEMUA MERAH'));assert(exported.events.some(e=>e.type==='simulator_output'));
  const csv=await (await fetch(`${base}/api/sessions/${sid}/export?format=csv`)).text();assert(csv.includes('application_ack'));assert(csv.startsWith('session_id,'));
  checks.push({name:'End, full clearance, synthetic outputs and durable JSON/CSV',pass:true});

  // Actual inference uses a public photo-loop fixture, never annotated traffic evidence.
  const realConfig={...JSON.parse(await readFile('validation/edge-density-demo-zones.json','utf8')),green_min_s:1,green_max_s:6,fallback_green_s:1,yellow_s:.3,all_red_s:.2};
  await writeFile('validation/edge-browser-demo-config.json',JSON.stringify(realConfig,null,2));
  let stdout='',stderr='',exitCode=null;
  agent=spawn(resolve('../../.venv/Scripts/python.exe'),['-X','utf8','examples/edge_density/edge_agent.py','--kind','file','--source','validation/transport-long-fixture.webm','--config','validation/edge-browser-demo-config.json','--weights','weights/yolo26n.pt','--simulator-url',base,'--max-frames','65','--report','validation/edge-integrated-inference.json'],{cwd:process.cwd(),windowsHide:true});
  agent.stdout.on('data',chunk=>stdout+=chunk);agent.stderr.on('data',chunk=>stderr+=chunk);agent.on('error',error=>errors.push(error.message));agent.on('exit',code=>exitCode=code);
  await waitUntil(()=>stdout.includes('simulator_session_id'),30000);
  const sessionLine=stdout.split(/\r?\n/).map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(v=>v?.simulator_session_id);
  const realId=sessionLine.simulator_session_id;
  await page.locator('#refresh').click();await page.locator('#sessions').selectOption(realId);await page.locator('#connect').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='BERJALAN');
  await waitUntil(async()=>{const data=await request(`/api/sessions/${realId}/export`);return data.events.some(e=>e.type==='application_ack'&&e.data.mode==='presence-adaptif');},16000);
  await waitUntil(()=>exitCode!==null,30000);assert.equal(exitCode,0,stderr);
  await page.waitForFunction(()=>document.querySelector('#quality').textContent.startsWith('CADANGAN'),null,{timeout:6000});
  const real=await request(`/api/sessions/${realId}/export`),inference=JSON.parse(await readFile('validation/edge-integrated-inference.json','utf8'));
  assert(inference.nms_free);assert(inference.processed_frames>=20);assert.equal(inference.transport,'local-http-simulator');
  assert.equal(real.metadata.nms_free,true);assert.equal(real.metadata.tracker,'ByteTrack');assert.equal(real.metadata.weights_sha256,inference.weights_sha256);
  assert(real.events.some(e=>e.type==='edge_proposal'&&e.data.rows?.some(r=>r.weighted_presence>0)));
  assert(real.events.some(e=>e.type==='application_ack'&&e.data.mode==='presence-adaptif'));
  assert(real.events.some(e=>e.type==='edge_proposal'&&e.data.reason==='agent-stopped'));
  let hasObservation=false;
  for(const event of real.events.filter(e=>e.type==='edge_proposal')){
    if(event.data.valid)hasObservation=true;
    else if(hasObservation)assert(['agent-stopped','end-of-file'].includes(event.data.reason),'Short healthy capture gaps must not become faults');
  }
  assert(real.events.some(e=>e.type==='simulator_output'&&e.data.vehicles.length>0));
  await page.screenshot({path:'validation/edge-simulator-browser.png',fullPage:true});
  await page.locator('#end').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='SELESAI');
  checks.push({name:'Real YOLO26 NMS-free + ByteTrack recording -> local relay -> simulator ACK -> source-stop fallback',pass:true,session_id:realId,frames:inference.processed_frames,scope:'Public photo loop, accelerated simulator timing; not accuracy or field acceptance'});
  assert.deepEqual(errors,[]);
  await writeFile('validation/edge-browser-check.json',JSON.stringify({passed:true,checks,page_errors:errors,scope:'Local foreground simulator integration, not physical lights or annotated evaluation'},null,2));
  process.stdout.write(JSON.stringify({passed:true,checks})+'\n');
}catch(error){
  await page.screenshot({path:'validation/edge-browser-failure.png',fullPage:true}).catch(()=>{});
  await writeFile('validation/edge-browser-check.json',JSON.stringify({passed:false,error:error.stack,checks,page_errors:errors},null,2));throw error;
}finally{
  if(timer)clearInterval(timer);if(agent&&agent.exitCode===null)agent.kill();await browser.close();
}
