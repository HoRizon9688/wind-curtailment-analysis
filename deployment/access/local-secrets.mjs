import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const localFile=fileURLToPath(new URL('../cloudflare/.dev.vars',import.meta.url));
export function readLocalSecrets(){
 if(!existsSync(localFile))throw Error('请先运行 npm run access:init 生成本地验收密钥。');
 return Object.fromEntries(readFileSync(localFile,'utf8').split(/\r?\n/).filter(x=>/^[A-Z_]+=/.test(x)).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1).trim()];}));
}
export function initialize(){
 if(existsSync(localFile)){readLocalSecrets();console.log('已有本地密钥，保持不变。');return;}
 writeFileSync(localFile,`# Local acceptance only. Generate different secrets for production.\nDAILY_ACCESS_SECRET=${randomBytes(32).toString('hex')}\nACCESS_SESSION_SECRET=${randomBytes(32).toString('hex')}\n`,{flag:'wx',mode:0o600});
 console.log('已生成仅本地验收使用的密钥，保存在被Git忽略的deployment/cloudflare/.dev.vars。');
}
if(process.argv[1]===fileURLToPath(import.meta.url))initialize();
