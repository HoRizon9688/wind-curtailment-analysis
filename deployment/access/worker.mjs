import {assertSecret,cookieToken,createSession,verifySession,dailyCode,dayWindow,sessionCookie,clearCookie,safeReturnPath,clientKey} from './core.mjs';
import {loginPage} from './login-page.mjs';

function headers(extra={}){return new Headers({'cache-control':'private, no-store, max-age=0','x-content-type-options':'nosniff','referrer-policy':'same-origin','vary':'Cookie',...extra});}
function redirect(location,cookie){const h=headers({location});if(cookie)h.set('set-cookie',cookie);return new Response(null,{status:303,headers:h});}
function unavailable(){return new Response('访问验证暂时不可用，请联系管理员。',{status:503,headers:headers({'content-type':'text/plain; charset=utf-8'})});}
async function limitedForm(request){
 if(!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get('content-type')??''))return {status:415};
 if(Number(request.headers.get('content-length')??0)>2048)return {status:413};
 const reader=request.body?.getReader();if(!reader)return {form:new URLSearchParams()};
 let size=0,text='';const decoder=new TextDecoder();
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2048){await reader.cancel();return {status:413};}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();return {form:new URLSearchParams(text)};}finally{reader.releaseLock();}
}
async function rateAllowed(request,env,now){
 const key=await clientKey(request,env.ACCESS_SESSION_SECRET);
 if(env.ACCESS_LOGIN_LIMITER)return (await env.ACCESS_LOGIN_LIMITER.limit({key})).success;
 const minute=Math.floor(now/60000),bucket=`${key}:${minute}`;
 const results=await env.ACCESS_RATE_DB.batch([
  env.ACCESS_RATE_DB.prepare('DELETE FROM access_login_attempts WHERE expires_at < ?').bind(now),
  env.ACCESS_RATE_DB.prepare('INSERT INTO access_login_attempts (bucket, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts').bind(bucket,(minute+2)*60000),
 ]);
 const count=results[1]?.results?.[0]?.attempts;
 if(!Number.isInteger(count))throw Error('Invalid rate counter');return count<=5;
}
export function createAccessWorker({now=()=>Date.now(),fetchAsset}={}){
 return {async fetch(request,env){
  try{
   assertSecret(env.DAILY_ACCESS_SECRET);assertSecret(env.ACCESS_SESSION_SECRET);
   if(env.DAILY_ACCESS_SECRET===env.ACCESS_SESSION_SECRET||(!env.ACCESS_LOGIN_LIMITER&&!env.ACCESS_RATE_DB)||(!fetchAsset&&!env.ASSETS))return unavailable();
   const time=now(),url=new URL(request.url),session=await verifySession(cookieToken(request),env.ACCESS_SESSION_SECRET,time);
   const destination=safeReturnPath(url.searchParams.get('returnTo'));
   function page(error='',status=200,returnTo=destination,logout=false){
    const nonce=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
    const h=headers({'content-type':'text/html; charset=utf-8','content-security-policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`});
    if(status===429)h.set('retry-after','60');
    return new Response(request.method==='HEAD'?null:loginPage({date:dayWindow(time).date,returnTo,nonce,error,logout}),{status,headers:h});
   }
   if(url.pathname==='/auth/login'){
    if(request.method==='GET'||request.method==='HEAD')return session?redirect(destination):page();
    if(request.method!=='POST')return new Response(null,{status:405,headers:headers({allow:'GET, HEAD, POST'})});
    if(request.headers.get('origin')!==url.origin)return page('请从本站登录页面提交口令。',403);
    if(!await rateAllowed(request,env,time))return page('尝试次数过多，请等待一分钟后再试。',429);
    const parsed=await limitedForm(request);if(parsed.status)return page('请求格式或大小不符合要求，请重新输入口令。',parsed.status);
    const code=parsed.form.get('code')??'',returnTo=safeReturnPath(parsed.form.get('returnTo'));
    if(parsed.form.getAll('code').length!==1||!/^\d{6}$/.test(code)||code!==await dailyCode(env.DAILY_ACCESS_SECRET,time))return page('口令不正确或已更新，请向管理员确认今日口令。',401,returnTo);
    return redirect(returnTo,sessionCookie(await createSession(env.ACCESS_SESSION_SECRET,time),time));
   }
   if(url.pathname==='/auth/logout'){
    if(request.method==='GET'||request.method==='HEAD')return page('',200,destination,true);
    if(request.method!=='POST')return new Response(null,{status:405,headers:headers({allow:'GET, HEAD, POST'})});
    if(request.headers.get('origin')!==url.origin)return page('请从本站退出页面提交请求。',403);
    return redirect('/auth/login',clearCookie());
   }
   if(url.pathname==='/auth/session'){
    if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405,headers:headers({allow:'GET, HEAD'})});
    return new Response(request.method==='HEAD'?null:JSON.stringify({authenticated:Boolean(session),expiresAt:session?.expiresAt??null}),{status:session?200:401,headers:headers({'content-type':'application/json'})});
   }
   if(!session)return redirect('/auth/login?'+new URLSearchParams({returnTo:safeReturnPath(url.pathname+url.search)}));
   if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405,headers:headers({allow:'GET, HEAD'})});
   const asset=await (fetchAsset?fetchAsset(request,env):env.ASSETS.fetch(request));
   const h=headers(Object.fromEntries(asset.headers));h.set('cache-control','private, no-store, max-age=0');h.set('vary','Cookie');h.delete('set-cookie');
   return new Response(request.method==='HEAD'?null:asset.body,{status:asset.status,headers:h});
  }catch{return unavailable();}
 }};
}
export default createAccessWorker();
