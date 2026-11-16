import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {Sha256} from '../dist/sha256.js';
import {RecordedSimulator} from '../dist/recorded-simulator.js';
import {defaults} from '../dist/core.js';

test('incremental file SHA-256 agrees with Node crypto across block and chunk boundaries',()=>{
  for(const size of [0,1,3,55,56,63,64,65,127,128,129,4097,1024*1024+17]){
    const bytes=randomBytes(size),hash=new Sha256();
    for(let start=0;start<size;start+=997)hash.update(bytes.subarray(start,start+997));
    assert.equal(hash.digest(),createHash('sha256').update(bytes).digest('hex'));
    assert.throws(()=>hash.update(new Uint8Array()));
  }
});
test('recorded-CCTV simulator receives only supplied observations and never its own queue sensor',()=>{
  const c=defaults(),output=new RecordedSimulator(c),seen=[],tick=output.controller.tick.bind(output.controller);
  output.controller.tick=(dt,snapshot)=>{seen.push(snapshot);return tick(dt,snapshot);};
  for(let i=0;i<120;i++)output.tick(.1,null);
  assert(seen.every(value=>value===null));assert.equal(output.controller.fallback,true);
  assert.equal(output.time,12);assert(Math.abs(output.controller.time-output.time)<1e-8);
  assert(output.sample().scope.includes('Synthetic'));assert(output.metrics().scope.includes('not recorded'));
});
test('recorded-CCTV controller signals move green vehicles and hold red vehicles',()=>{
  const c=defaults(),output=new RecordedSimulator(c,'fixed');
  output.world.arrivals=[];output.world.cars=[{id:1,dir:0,pos:.03,wait:0,arrival:0,departed:null},{id:2,dir:1,pos:.03,wait:0,arrival:0,departed:null}];
  for(let i=0;i<40;i++)output.tick(.1,null);
  assert(output.cars.find(car=>car.id===1).pos<0);assert.equal(output.cars.find(car=>car.id===2).pos,.03);
  assert.deepEqual(output.sample().active_rois,[0]);assert.equal(output.controller.decisions.length,0);
});
