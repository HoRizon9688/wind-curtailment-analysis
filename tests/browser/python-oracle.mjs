import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export function oracle(request) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.env.BROWSER_ORACLE_PYTHON||'python',[fileURLToPath(new URL('./python-oracle.py',import.meta.url))],{windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
    let output='',error='';const timeout=setTimeout(()=>{child.kill();reject(new Error('Python oracle timeout'));},120_000);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{error+=chunk;});
    child.on('error',e=>{clearTimeout(timeout);reject(e);});
    child.on('close',code=>{clearTimeout(timeout);if(code!==0)reject(new Error(error||`oracle exit ${code}`));else {try{resolve(JSON.parse(output));}catch(e){reject(e);}}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request));
  });
}
export const oracleInput=input=>({...input,power:input.power.map(f=>({...f,bytes:Buffer.from(f.bytes).toString('base64')})),forecast:input.forecast.map(f=>({...f,bytes:Buffer.from(f.bytes).toString('base64')}))});
