const DAY_MS=86400000, OFFSET_MS=8*3600000;
const encoder=new TextEncoder();
export const COOKIE_NAME='__Host-wind-access';
export function dayWindow(now=Date.now()){
 const index=Math.floor((now+OFFSET_MS)/DAY_MS);
 return {date:new Date(index*DAY_MS).toISOString().slice(0,10),expiresAt:(index+1)*DAY_MS-OFFSET_MS};
}
export function assertSecret(secret){
 if(typeof secret!=='string'||encoder.encode(secret).length<32)throw Error('Access secret must contain at least 32 bytes');
}
async function key(secret,usage){
 assertSecret(secret);
 return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,[usage]);
}
export async function sign(secret,text){return new Uint8Array(await crypto.subtle.sign('HMAC',await key(secret,'sign'),encoder.encode(text)));}
function encode(bytes){return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function decode(value){
 if(!/^[A-Za-z0-9_-]+$/.test(value))throw Error('Invalid token');
 return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
}
export async function dailyCode(secret,now=Date.now()){
 const digest=await sign(secret,`wind-daily-access:v1:${dayWindow(now).date}`);
 const offset=digest[31]&15;
 const number=((digest[offset]&127)*16777216+digest[offset+1]*65536+digest[offset+2]*256+digest[offset+3])%1000000;
 return String(number).padStart(6,'0');
}
export async function createSession(secret,now=Date.now()){
 const w=dayWindow(now);
 const payload=encode(encoder.encode(JSON.stringify({v:1,date:w.date,expiresAt:w.expiresAt,nonce:encode(crypto.getRandomValues(new Uint8Array(16)))})));
 return `${payload}.${encode(await sign(secret,`wind-session:v1:${payload}`))}`;
}
export async function verifySession(token,secret,now=Date.now()){
 try{
  if(typeof token!=='string'||token.length>1024)return null;
  const parts=token.split('.');if(parts.length!==2)return null;
  const signature=decode(parts[1]);if(signature.length!==32)return null;
  if(!await crypto.subtle.verify('HMAC',await key(secret,'verify'),signature,encoder.encode(`wind-session:v1:${parts[0]}`)))return null;
  const data=JSON.parse(new TextDecoder().decode(decode(parts[0]))),w=dayWindow(now);
  if(data.v!==1||data.date!==w.date||data.expiresAt!==w.expiresAt||now>=data.expiresAt||typeof data.nonce!=='string'||!/^[\w-]{22}$/.test(data.nonce))return null;
  return data;
 }catch{return null;}
}
export function cookieToken(request){
 const cookies=(request.headers.get('cookie')??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(COOKIE_NAME+'='));
 return cookies.length===1?cookies[0].slice(COOKIE_NAME.length+1):null;
}
export function sessionCookie(token,now=Date.now()){
 const exp=dayWindow(now).expiresAt;
 return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0,Math.floor((exp-now)/1000))}; Expires=${new Date(exp).toUTCString()}`;
}
export function clearCookie(){return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;}
export function safeReturnPath(value){
 const fallback='/?view=1&tab=dashboard';
 if(typeof value!=='string'||value.length>2048||!value.startsWith('/')||value.startsWith('//')||/[\\\x00-\x20]/.test(value))return fallback;
 try{
  const url=new URL(value,'https://return.invalid');
  if(url.origin!=='https://return.invalid'||decodeURIComponent(url.pathname).startsWith('/auth'))return fallback;
  return url.pathname+url.search+url.hash;
 }catch{return fallback;}
}
export async function clientKey(request,secret){
 const ip=request.headers.get('CF-Connecting-IP')??'unidentified';
 return encode(await sign(secret,`wind-login-client:v1:${ip}`));
}
