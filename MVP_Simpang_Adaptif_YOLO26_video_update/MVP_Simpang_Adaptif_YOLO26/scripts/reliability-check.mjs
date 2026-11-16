import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {defaults,Simulation} from '../dist/core.js';
import {auditControl} from '../dist/visual-simulator.js';

const base=process.env.SIMPANG_URL??'http://127.0.0.1:8000';
const sessionId=randomUUID(),config=defaults(),world=new Simulation(config);
const report={scope:'Accelerated 1800-second telemetry/controller/SQLite integration; not visual inference endurance',session_id:sessionId,horizon_s:1800,warmup_s:300,pass:false};
async function request(path,body){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!response.ok)throw Error(`${response.status}: ${await response.text()}`);return response;}
await request('/api/sessions',{session_id:sessionId,config,source:'reliability-telemetry',source_name:'seeded-queue-simulator',mode:'adaptive',metadata:{accelerated_clock:true,scope:report.scope}});
let snapshots=0,decisions=0,transitions=0,events=[];
const flush=async()=>{if(events.length){await request(`/api/sessions/${sessionId}/events`,{events});events=[];}};
try{
  for(let tick=0;tick<18000;tick++){
    world.tick(.1);
    for(;snapshots<world.snapshots.length;snapshots++)events.push({type:'snapshot',time:world.snapshots[snapshots].time,data:world.snapshots[snapshots]});
    for(;decisions<world.controller.decisions.length;decisions++)events.push({type:'decision',time:world.controller.decisions[decisions].time,data:world.controller.decisions[decisions]});
    for(;transitions<world.controller.events.length;transitions++)events.push({type:'transition',time:world.controller.events[transitions].time,data:world.controller.events[transitions]});
    if(tick%50===49)await flush();
  }
  await flush();
  const audit=auditControl(config,world.controller.events,world.controller.decisions,world.time);
  assert(audit.nfr05_pass&&audit.no_skipped_phase&&audit.red_bound_pass&&audit.complete_decision_log);
  await request(`/api/sessions/${sessionId}/end`,{status:'ended',time:world.time,reason:'accelerated_reliability_complete'});
  const exported=await (await request(`/api/sessions/${sessionId}/export?format=json`)).json();
  const count=type=>exported.events.filter(event=>event.type===type).length;
  assert.equal(exported.status,'ended');assert.equal(count('snapshot'),snapshots);assert.equal(count('decision'),decisions);assert.equal(count('transition'),transitions);
  assert((await (await request(`/api/sessions/${sessionId}/export?format=csv`)).text()).startsWith('session_id,'));
  Object.assign(report,{pass:true,completed_simulation_s:world.time,journal:{snapshots,decisions,transitions,json_readable:true,csv_readable:true,config_sha256:exported.config_sha256},control_audit:audit,metrics:world.metrics(300)});
}catch(error){report.error=String(error);await request(`/api/sessions/${sessionId}/end`,{status:'failed',time:world.time,reason:report.error}).catch(()=>{});throw error;}
finally{writeFileSync('validation/reliability-check.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify({pass:report.pass,session_id:sessionId,simulated_s:world.time,...report.journal}));
