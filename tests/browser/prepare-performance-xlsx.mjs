import {mkdirSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {syntheticInput} from './performance-input.mjs';
const folder=new URL('../../reports/browser-review/T4/xlsx-synthetic/',import.meta.url);mkdirSync(folder,{recursive:true});
const input=syntheticInput(31);
for(const [kind,files] of Object.entries({power:input.power,forecast:input.forecast}))writeFileSync(new URL(`synthetic-${kind}.csv`,folder),new Uint8Array(files[0].bytes));
const run=spawnSync(process.env.BROWSER_ORACLE_PYTHON||'python',[fileURLToPath(new URL('./generate-performance-xlsx.py',import.meta.url))],{windowsHide:true,encoding:'utf8'});
process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');if(run.error)throw run.error;process.exitCode=run.status??1;
