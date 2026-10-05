import test from 'node:test';
import assert from 'node:assert/strict';
import {semanticColorMetadata} from '../../dashboard/src/charting/chart-theme.js';

// Literal palette expectations: x/y hash to slots 0/1. kind:aa/bb/cc
// all hash to slot 6. Collision avoidance is per query: first uses 6/7;
// second already owns bb at 7 and can use 6 for cc.
test('heterogeneous queries retain measures, shared categories and exclude text payload',()=>{
 const q={
  first:{payloadColumns:['source'],rows:[
   {kind:'aa',x:1,source:'one',empty:'',nil:null,flag:true,date:'2026-08-01',all:'ALL'},
   {kind:'bb',y:2,source:'two',url:'https://example.invalid'},
  ]},
  second:{payloadColumns:['source'],rows:[{kind:'bb',x:3,source:'three'},{kind:'cc',y:4,source:'four'}]},
 };
 const before=structuredClone(q);
 assert.deepEqual(semanticColorMetadata(q),{
  version:1,
  assignments:[['kind:aa','var(--chart-7)'],['kind:bb','var(--chart-8)'],['kind:cc','var(--chart-7)']],
  measureAssignments:[['x','oklch(from var(--chart-1) l max(c, 0.16) calc(h + 0))'],['y','oklch(from var(--chart-1) l max(c, 0.16) calc(h + 180))']],
  categoryFields:[['aa','var(--chart-7)'],['bb','var(--chart-8)'],['cc','var(--chart-7)']],
 });
 assert.deepEqual(q,before);
});

test('three colliding values in one query keep sorted allocation and wrap',()=>{
 assert.deepEqual(semanticColorMetadata({query:{rows:[{kind:'cc'},{kind:'aa'},{kind:'bb'}]}}),{
  version:1,assignments:[['kind:aa','var(--chart-7)'],['kind:bb','var(--chart-8)'],['kind:cc','var(--chart-1)']],
  measureAssignments:[],categoryFields:[['cc','var(--chart-1)'],['aa','var(--chart-7)'],['bb','var(--chart-8)']],
 });
});

test('only own enumerable string keys are scanned, including null-prototype rows',()=>{
 const row=Object.assign(Object.create({inherited:'not-a-category'}),{kind:'aa',x:1});
 Object.defineProperty(row,'hidden',{value:'hidden-category',enumerable:false});
 row[Symbol('symbol')]='symbol-category';
 const plain=Object.assign(Object.create(null),{kind:'aa',x:2});
 assert.deepEqual(semanticColorMetadata({query:{rows:[row,plain]}}),{
  version:1,assignments:[['kind:aa','var(--chart-7)']],
  measureAssignments:[['x','oklch(from var(--chart-1) l max(c, 0.16) calc(h + 0))']],
  categoryFields:[['aa','var(--chart-7)']],
 });
});

test('numeric payload remains a measure and invalid numbers create no category',()=>{
 assert.deepEqual(semanticColorMetadata({query:{payloadColumns:['x'],rows:[{x:1,missing:undefined,infinite:Infinity,nan:NaN},{x:null}]}}),{
  version:1,assignments:[],
  measureAssignments:[['x','oklch(from var(--chart-1) l max(c, 0.16) calc(h + 0))']],categoryFields:[],
 });
});
