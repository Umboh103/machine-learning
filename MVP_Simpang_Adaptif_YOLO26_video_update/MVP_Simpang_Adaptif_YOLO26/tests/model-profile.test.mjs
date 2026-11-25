import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults} from '../dist/core.js';
import {applyModelProfile} from '../dist/model-profile.js';

const trained={id:'trained-checkpoint',weights:'best.pt',vehicleClasses:[0,1,2,3,4,5,6],confidence:.25,imgsz:640};

test('switching from COCO to the trained model counts bus ID 1 and preserves camera and phase settings',()=>{
  const saved=defaults();saved.cameraGeometry={width:1920,height:1080};saved.fixed=40;
  const updated=applyModelProfile(saved,trained);
  assert.deepEqual(updated.vehicleClasses,[0,1,2,3,4,5,6]);assert.equal(updated.imgsz,640);
  assert.deepEqual(updated.rois,saved.rois);assert.deepEqual(updated.cameraGeometry,saved.cameraGeometry);
  assert.deepEqual(updated.phases,saved.phases);assert.equal(updated.fixed,40);
  assert.deepEqual(saved.vehicleClasses,[2,3,5,7]);
});

test('health refresh preserves the operator class subset and thresholds for the same model',()=>{
  const saved={...applyModelProfile(defaults(),trained),vehicleClasses:[1,2,3,5,6],confidence:.4,imgsz:960};
  assert.equal(applyModelProfile(saved,trained),saved);
  const next=applyModelProfile(saved,{...trained,id:'retrained-checkpoint'});
  assert.deepEqual(next.vehicleClasses,trained.vehicleClasses);assert.equal(next.confidence,.25);
});

test('older backends without a detector profile preserve existing configuration',()=>{
  const saved=defaults();assert.equal(applyModelProfile(saved,null),saved);
});
