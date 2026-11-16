import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EdgeController,EdgeSimulator} from '../dist/edge-controller.js';

const original=JSON.parse(readFileSync(new URL('../examples/edge_density/config.example.json',import.meta.url)));
const config=()=>({...structuredClone(original),green_min_s:1,green_max_s:6,fallback_green_s:4,yellow_s:.3,all_red_s:.2});
function packet(seq,at,extra={}){
  const c=config();return {schema:'traffic-plan-proposal-v1',session_id:'test',intersection_id:c.intersection_id,config_sha256:'hash',output_scope:'simulator-proposals-only',seq,frame_id:seq,source_epoch:1,created_at_utc_ms:at,valid_until_utc_ms:at+2000,valid:true,phase_order:c.phase_order,green_min_s:1,green_max_s:6,fallback_green_s:4,green_s:[1,2,3,5],rows:[],...extra};
}
function ready(c){for(let i=0;i<3;i++)c.receive(packet(i+1,i*1000),i*1000,i*1000);c.quality(2000);}

test('requires distinct observations at one-second cadence; replay cannot recover',()=>{
  const c=new EdgeController(config(),'hash','test');c.receive(packet(1,0),0,0);
  assert.equal(c.receive(packet(1,0),1000,1000),false);c.quality(1000);assert(c.fallback);
  assert.throws(()=>c.receive(packet(2,1000,{frame_id:1}),1000,1000));
  c.receive(packet(2,1000),1000,1000);c.receive(packet(3,2000),2000,2000);c.quality(2000);assert.equal(c.fallback,false);
});
test('freezes next duration and executes full yellow/all-red before application ACK',()=>{
  const c=new EdgeController(config(),'hash','test');ready(c);
  c.tick(4,2000);assert.equal(c.phase,0);assert.equal(c.state,'KUNING');assert.equal(c.pending.green,2);
  c.receive(packet(4,3000,{green_s:[1,6,3,5]}),3000,3000);
  c.tick(.3,3000);assert.equal(c.state,'SEMUA MERAH');assert.equal(c.phase,0);
  c.tick(.2,3000);assert.equal(c.phase,1);assert.equal(c.state,'HIJAU');assert.equal(c.duration,2);
  const ack=c.events.find(e=>e.type==='application_ack');assert.equal(ack.data.proposal_seq,3);assert.equal(ack.data.applied_at,4.5);
});
test('invalid or expired source at application cancels pending adaptive green',()=>{
  for(const invalid of [false,true]){
    const c=new EdgeController(config(),'hash','test');ready(c);c.tick(4,2000);
    if(invalid)c.receive(packet(4,3000,{valid:false,valid_until_utc_ms:3000,rows:null,green_s:null,reason:'agent-stopped'}),3000,3000);
    c.tick(.5,invalid?3000:4001);assert.equal(c.duration,4);assert.equal(c.events.find(e=>e.type==='application_ack').data.mode,'cadangan');
  }
});
test('reconnect resets recovery; changed epoch during clearance cancels frozen plan',()=>{
  const c=new EdgeController(config(),'hash','test');ready(c);c.tick(4,2000);
  c.receive(packet(4,3000,{source_epoch:2}),3000,3000);c.tick(.5,3000);assert.equal(c.duration,4);assert.equal(c.streak,1);
});
test('rejects wrong configuration, identity, phase mapping, timing and invalid timestamps',()=>{
  for(const extra of [{config_sha256:'other'},{session_id:'other'},{phase_order:[1,0,2,3]},{green_s:[1,99,3,5]},{valid_until_utc_ms:99999},{created_at_utc_ms:99999},{seq:NaN}]){
    assert.throws(()=>new EdgeController(config(),'hash','test').receive(packet(1,0,extra),0,0));
  }
});
test('fallback cycles through every exclusive movement without starvation',()=>{
  const c=new EdgeController(config(),'hash','test');c.tick(20,20000);
  assert.deepEqual(c.events.filter(e=>e.type==='application_ack').map(e=>e.data.to),[1,2,3,0]);
  assert(c.decisions.every(d=>d.mode==='cadangan'&&d.green===4));assert.equal(c.time,20);
});
test('simulator obeys green/red and never feeds its own telemetry to the controller',()=>{
  const output=new EdgeSimulator(config(),'hash','test');output.world.arrivals=[];
  output.world.cars=[{id:1,dir:0,pos:.03,wait:0,arrival:0,departed:null},{id:2,dir:1,pos:.03,wait:0,arrival:0,departed:null}];
  for(let i=0;i<10;i++)output.tick(.1,i*100);
  assert(output.world.cars[0].pos<0);assert.equal(output.world.cars[1].pos,.03);
  assert.equal(output.controller.latest,null);assert(output.controller.fallback);assert(Math.abs(output.controller.time-output.world.time)<1e-8);
});
test('configuration remains immutable and long pauses cannot extend observation TTL',()=>{
  assert.throws(()=>new EdgeController({...config(),all_red_s:0},'hash','test'));
  assert.throws(()=>new EdgeController({...config(),fallback_green_s:0},'hash','test'));
  const input=config(),c=new EdgeController(input,'hash','test');ready(c);input.phase_order.reverse();
  assert.deepEqual(c.config.phase_order,[0,1,2,3]);assert.throws(()=>c.config.phase_order.reverse());
  c.tick(.1,9000);assert(c.fallback);assert.equal(c.streak,0);
});
