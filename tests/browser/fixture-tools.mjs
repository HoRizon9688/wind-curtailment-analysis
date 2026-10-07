import {readFileSync,existsSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
export const ROOT=new URL('../fixtures/browser/contract/',import.meta.url);
const current=new URL('../fixtures/browser/dispatch-confirmation-v2/',import.meta.url);
export const fixturePath=path=>{const v2=new URL(path,current);return existsSync(v2)?v2:new URL(path,ROOT);};
export const loadJson=path=>JSON.parse(readFileSync(fixturePath(path)));
export const loadExpected=path=>JSON.parse(gunzipSync(readFileSync(fixturePath(path))));
export const inputFile=path=>{const b=readFileSync(new URL(path,ROOT));return {name:path.split('/').at(-1),bytes:b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)};};
export const fixtureInput=c=>({power:c.power.map(inputFile),forecast:c.forecast.map(inputFile),options:c.options});
