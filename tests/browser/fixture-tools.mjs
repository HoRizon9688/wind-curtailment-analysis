import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
export const ROOT=new URL('../fixtures/browser/contract/',import.meta.url);
export const loadJson=path=>JSON.parse(readFileSync(new URL(path,ROOT)));
export const loadExpected=path=>JSON.parse(gunzipSync(readFileSync(new URL(path,ROOT))));
export const inputFile=path=>{const b=readFileSync(new URL(path,ROOT));return {name:path.split('/').at(-1),bytes:b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)};};
export const fixtureInput=c=>({power:c.power.map(inputFile),forecast:c.forecast.map(inputFile),options:c.options});
