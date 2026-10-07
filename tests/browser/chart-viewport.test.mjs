import test from 'node:test';
import assert from 'node:assert/strict';
import * as viewport from '../../dashboard/src/content/dashboard/chart-viewport.mjs';

test('dragging pans time without changing the visible duration',()=>{
  assert.deepEqual(viewport.panRange([600,900],100,500),[540,840]);
  assert.deepEqual(viewport.panRange([600,900],-100,500),[660,960]);
  assert.deepEqual(viewport.panRange([0,300],100,500),[0,300]);
  assert.deepEqual(viewport.panRange([1140,1440],-100,500),[1140,1440]);
  assert.deepEqual(viewport.panRange([0,1440],-100,500),[0,1440]);
});
test('wheel zoom preserves the time beneath the cursor within minute rounding',()=>{
  for(const position of [0,.25,.5,.75,1]){
    const range=[600,900],anchor=range[0]+position*(range[1]-range[0]);
    const next=viewport.zoomRange(range,position,-120);
    assert.ok(next[1]-next[0]<300);
    assert.ok(Math.abs(next[0]+position*(next[1]-next[0])-anchor)<=1);
    const expanded=viewport.zoomRange(next,position,120);
    assert.ok(expanded[1]-expanded[0]>next[1]-next[0]);
  }
});
test('repeated wheel events stay between 15 minutes and the full day',()=>{
  let range=[0,1440];
  for(let i=0;i<100;i++)range=viewport.zoomRange(range,.2,-120);
  assert.equal(range[1]-range[0],15);
  for(let i=0;i<100;i++)range=viewport.zoomRange(range,.8,120);
  assert.deepEqual(range,[0,1440]);
  assert.deepEqual(viewport.zoomRange([0,1440],0,0),[0,1440]);
  assert.deepEqual(viewport.zoomRange([0,60],0,-120),[0,47]);
  assert.deepEqual(viewport.zoomRange([1380,1440],1,-120),[1393,1440]);
});
test('wheel delta modes and out-of-bounds pan preserve valid integer ranges',()=>{
  assert.deepEqual(viewport.zoomRange([300,900],.5,-3,1),viewport.zoomRange([300,900],.5,-48,0));
  assert.deepEqual(viewport.zoomRange([300,900],.5,1,2),viewport.zoomRange([300,900],.5,800,0));
  for(const [delta,width] of [[1e5,500],[-1e5,500],[10,0],[Infinity,500]]){
    const next=viewport.panRange([300,900],delta,width);
    assert.ok(next[0]>=0&&next[1]<=1440);
    assert.equal(next[1]-next[0],600);
    assert.ok(next.every(Number.isInteger));
  }
});
