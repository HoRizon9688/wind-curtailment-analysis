import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTime,formatTime} from '../../dashboard/src/content/calculation/time.mjs';
import {normalizeInputs} from '../../dashboard/src/content/calculation/input-model.mjs';
import {readTable,numberOrNull} from '../../dashboard/src/content/calculation/table-reader.mjs';
import {loadJson,fixtureInput} from './fixture-tools.mjs';

test('time and numeric parsing match frozen Python oracles; no loss of fractional seconds',()=>{
  for(const c of loadJson('times.json')) {
    if(c.error)assert.throws(()=>parseTime(c.input),e=>e.code==='TIME'&&e.message===c.error);
    else assert.equal(formatTime(parseTime(c.input)),c.expected);
  }
  for(const c of loadJson('numbers.json'))assert.equal(numberOrNull(c.input),c.expected,JSON.stringify(c.input));
  for(const v of ['2026-02-29','2026-04-31','2026-08-01T24:00','2026-08-01T00:00:00.000001','2026-08-01Z'])assert.throws(()=>parseTime(v));
  assert.equal(formatTime(parseTime('2026/8/1 0:15')),'2026-08-01T00:15:00+08:00');
  assert.equal(formatTime(parseTime('0001-01-01T00:00')),'0001-01-01T00:00:00+08:00');
});

test('every normalized map, duplicate count, source, station and fatal error matches Python',async()=>{
  const cases=loadJson('manifest.json').cases;
  for(const expected of loadJson('normalized.json')) {
    const input=fixtureInput(cases.find(c=>c.id===expected.id));
    const [p,f]=await Promise.all([Promise.all(input.power.map(readTable)),Promise.all(input.forecast.map(readTable))]);
    if(expected.error)assert.throws(()=>normalizeInputs(p,f),e=>e.message===expected.error.message&&e.code===expected.error.code,expected.id);
    else {
      const n=normalizeInputs(p,f);
      assert.deepEqual([...n.power].sort((a,b)=>a[0]-b[0]).map(([t,v])=>[formatTime(t),v]),expected.power,expected.id);
      assert.deepEqual([...n.forecasts].sort((a,b)=>a[0]-b[0]).map(([t,v])=>[formatTime(t),v]),expected.forecasts,expected.id);
      const {powerDuplicates,files,...metadata}=n.metadata;
      assert.equal(powerDuplicates,expected.powerDuplicates);assert.deepEqual(metadata,expected.metadata);
      assert.equal(files.length,input.power.length+input.forecast.length);
    }
  }
});

test('numeric coercion rejects JS-specific bases, whitespace and objects but accepts Python decimal strings',()=>{
  for(const x of ['0x10','0b10','1__0','1_','_1','1e_2','\ufeff1',[],{},new Date()])assert.equal(numberOrNull(x),null);
  for(const [x,y] of [['\u00851',1],['1_0.0_5',10.05],['+１２.٥',12.5]])assert.equal(numberOrNull(x),y);
});
