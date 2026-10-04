import test from 'node:test';
import assert from 'node:assert/strict';
import {ThresholdAllocator} from '../../dashboard/src/content/calculation/threshold-allocator.mjs';
import {compareResults} from './compare.mjs';
import {loadJson} from './fixture-tools.mjs';
test('all independent hand and hysteresis sequences match full Python allocator output',()=>{
  for(const c of loadJson('allocator.json')) {
    const m=new ThresholdAllocator(c.capacity);const actual=c.inputs.map(x=>m.calculate(x.a,x.f,x.g,x.p));
    const review=compareResults({rows:c.expected},{rows:actual});assert.equal(review.equal,true,JSON.stringify({id:c.id,first:review.first}));
  }
});
test('existing Python allocator behaviours: near-following, floor, reset, invalid input and scale',()=>{
  const m=new ThresholdAllocator(56);assert.ok(Math.abs(m.calculate(31.6056,16.92,17.0594,17.2331).prediction*60-14.3725)<1e-9);
  const h=new ThresholdAllocator(100);h.calculate(100,80,78.9,70);h.reset();assert.equal(h.calculate(100,80,79.2,70).dispatchState,false);
  assert.equal(new ThresholdAllocator(100,2).calculate(100,80,78.5,70).dispatchState,false);
  for(const capacity of [0,-1,NaN,Infinity])assert.throws(()=>new ThresholdAllocator(capacity));
  for(const x of [-1,NaN,Infinity])assert.throws(()=>m.calculate(x,1,1,1));
  const belowFloor=new ThresholdAllocator(56).calculate(1,.1,1.12,.5);
  assert.equal(belowFloor.floorFollowing,true);assert.equal(belowFloor.prediction,0);assert.equal(belowFloor.referenceTotal,0);assert.ok(Math.abs(belowFloor.operationalBelow*60-.5)<1e-9);
  const highAgc=new ThresholdAllocator(56).calculate(10,.1,3,1);
  assert.equal(highAgc.floorFollowing,false);assert.equal(highAgc.prediction,0);assert.ok(Math.abs(highAgc.unexplainedAbove*60-7)<1e-9);
  const pending=new ThresholdAllocator(100).calculate(100,60,80,75);
  assert.equal(pending.prediction,0);assert.ok(Math.abs(pending.unexplainedAbove*60-20)<1e-9);assert.ok(Math.abs(pending.operationalBelow*60-5)<1e-9);
});
test('fixed seed random sequences: nonnegative, both closures and area integral',()=>{
  let seed=43;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  for(const capacity of [5,56,100,1500]) {
    const m=new ThresholdAllocator(capacity);
    for(let i=0;i<2000;i++) {
      const r=m.calculate(...Array.from({length:4},()=>random()*capacity));
      assert.ok(Math.abs(r.gap-r.dispatch-r.prediction-r.other)<1e-9);
      assert.ok(Math.abs(r.referenceTotal-r.dispatch-r.prediction-r.noiseAbove-r.unexplainedAbove-r.releasedAboveAgc)<1e-9);
      for(const k of ['dispatch','prediction','other']) {
        assert.ok(r[k]>=0);const area=r.allocationBands.filter(b=>b.kind===k).reduce((s,b)=>s+(b.top-b.bottom)/60,0);assert.ok(Math.abs(area-r[k])<1e-9);
      }
    }
  }
});
