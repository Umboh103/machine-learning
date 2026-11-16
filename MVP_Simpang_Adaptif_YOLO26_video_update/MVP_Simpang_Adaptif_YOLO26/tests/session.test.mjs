import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionLog} from '../dist/session-log.js';

const memory=()=>{const values=new Map();return{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)}};
const ok=data=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});

test('committed events survive ambiguous response and reload without duplication',async()=>{
  const storage=memory(),received=new Set();let fail=true;
  const request=async(path,options)=>{for(const event of JSON.parse(options.body).events)received.add(event.client_event_id);if(fail)throw Error('response lost');return ok({saved:1});};
  const first=new SessionLog({storage,request});first.append('session','snapshot',1,{rows:[{q:0,w:0}]});
  await assert.rejects(first.flush(),/response lost/);assert.equal(first.pending.length,1);assert.equal(received.size,1);
  fail=false;const restored=new SessionLog({storage,request});await restored.flush();assert.equal(restored.pending.length,0);assert.equal(received.size,1);
});

test('failed session finalization persists and retries after a tab reload',async()=>{
  const storage=memory(),calls=[];let fail=true,ended=false;
  const request=async(path,options)=>{calls.push(path);if(path.endsWith('/end')){if(fail)throw Error('backend offline');ended=true;}return ok({});};
  const first=new SessionLog({storage,request});first.append('session','decision',30,{green:25});
  await assert.rejects(first.end('session',35,'eof'),/backend offline/);
  assert.equal(first.pending.length,1);assert.equal(first.pending[0].end.reason,'eof');assert.equal(ended,false);
  assert.deepEqual(calls,['/api/sessions/session/events','/api/sessions/session/end']);
  fail=false;const restored=new SessionLog({storage,request});await restored.flush();assert.equal(ended,true);assert.equal(restored.pending.length,0);
});

test('ambiguous committed finalization can be retried idempotently',async()=>{
  const storage=memory();let fail=true,endCalls=0,serverEnded=false,terminalTransitions=0;
  const request=async(path)=>{if(path.endsWith('/end')){endCalls++;if(!serverEnded){serverEnded=true;terminalTransitions++;}if(fail)throw Error('reply dropped');}return ok({status:'ended'});};
  const log=new SessionLog({storage,request});await assert.rejects(log.end('s',10),/reply dropped/);
  await assert.rejects(log.end('s',10),/reply dropped/);assert.equal(log.pending.length,1);
  fail=false;await new SessionLog({storage,request}).flush();assert.equal(endCalls,3);assert.equal(terminalTransitions,1);
});

test('overlapping flushes serialize and include events added while awaiting acknowledgement',async()=>{
  const storage=memory(),batches=[];let release;
  const barrier=new Promise(resolve=>{release=resolve;});
  const request=async(path,options)=>{batches.push(JSON.parse(options.body).events);if(batches.length===1)await barrier;return ok({});};
  const log=new SessionLog({storage,request});log.append('s','snapshot',1,{});
  const first=log.flush(),second=log.flush();log.append('s','snapshot',2,{});release();await Promise.all([first,second]);
  assert.equal(batches.length,2);assert.equal(batches[0][0].time,1);assert.equal(batches[1][0].time,2);assert.equal(log.pending.length,0);
});

test('FIFO outbox never batches through a pending end operation',async()=>{
  const storage=memory(),order=[];const request=async(path,options)=>{order.push(path.endsWith('/end')?'end':JSON.parse(options.body).events[0].type);return ok({});};
  const log=new SessionLog({storage,request});log.append('s','first',1,{});
  log.pending.push({session_id:'s',operation_id:'end-1',end:{status:'ended',time:2,reason:'user'}});
  log.append('other','later',3,{});await log.flush();assert.deepEqual(order,['first','end','later']);
});

test('starting another session first retries the pending previous end',async()=>{
  const storage=memory(),order=[];const log=new SessionLog({storage,request:async(path)=>{order.push(path);return ok({});}});
  log.pending.push({session_id:'old',operation_id:'end-old',end:{status:'ended',time:3}});log.save();
  await log.start({session_id:'new'});assert.deepEqual(order,['/api/sessions/old/end','/api/sessions']);
});

test('mandatory journal failure invokes halt callback and retains failed finalization',async()=>{
  const storage=memory();const errors=[];let healthy=false;
  const request=async()=>{if(!healthy)throw Error('disk unavailable');return ok({});};
  const log=new SessionLog({storage,request,onFailure:(error,context)=>errors.push({message:error.message,...context})});
  log.append('s','snapshot',1,{});await assert.rejects(log.flush(),/disk unavailable/);
  assert.equal(errors[0].operation,'events');assert.equal(log.lastFailure.message,'disk unavailable');
  await assert.rejects(log.end('s',2,'mandatory-log-failure','failed'),/disk unavailable/);
  assert.equal(log.pending.at(-1).end.status,'failed');healthy=true;await log.flush();assert.equal(log.pending.length,0);assert.equal(log.lastFailure,null);
});

test('local outbox quota failure invokes halt callback and keeps memory journal',()=>{
  const errors=[];const log=new SessionLog({storage:{getItem:()=>null,setItem:()=>{throw Error('quota exceeded')}},onFailure:error=>errors.push(error)});
  log.append('s','snapshot',1,{});assert.equal(log.pending.length,1);assert.equal(errors[0].message,'quota exceeded');assert.equal(log.lastFailure.message,'quota exceeded');
});
