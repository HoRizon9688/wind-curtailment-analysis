import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeFiles} from '../../dashboard/src/content/calculation/analyze.mjs';
import {fixtureInput,loadJson,loadExpected} from './fixture-tools.mjs';
import {compareResults} from './compare.mjs';
test('optional progress reports real phases without changing any Result field',async()=>{
  const c=loadJson('manifest.json').cases.find(c=>c.id==='continuous-day-56mw');const events=[];
  const result=await analyzeFiles(fixtureInput(c),p=>events.push(p));
  assert.equal(compareResults(loadExpected(c.expected),result).equal,true);
  assert.deepEqual([...new Set(events.map(p=>p.phase))],['reading','validating','calculating','aggregating']);
  assert.equal(events.find(p=>p.phase==='reading').total,c.power.length+c.forecast.length);
});
