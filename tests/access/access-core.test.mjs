import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyCode,dayWindow,createSession,verifySession,safeReturnPath} from '../../deployment/access/core.mjs';
const secret='local-test-code-secret-000000000000000000000000';
const sessionSecret='local-test-session-secret-00000000000000000000';
const now=Date.parse('2026-10-08T04:00:00Z');
test('Beijing day changes at 16:00 UTC and expires at that boundary',()=>{
 assert.equal(dayWindow(Date.parse('2026-10-07T15:59:59Z')).date,'2026-10-07');
 assert.equal(dayWindow(Date.parse('2026-10-07T16:00:00Z')).date,'2026-10-08');
 assert.equal(dayWindow(now).expiresAt,Date.parse('2026-10-08T16:00:00Z'));
});
test('daily code is six digits, stable during a day and secret dependent',async()=>{
 const code=await dailyCode(secret,now);assert.match(code,/^\d{6}$/);
 assert.equal(code,await dailyCode(secret,now+3600000));
 assert.notEqual(code,await dailyCode(secret,now+86400000));
 assert.notEqual(code,await dailyCode(secret+'changed',now));
 await assert.rejects(()=>dailyCode('short',now));
});
test('sessions reject tampering, expiry, wrong secret, and dates outside the current day',async()=>{
 const token=await createSession(sessionSecret,now);
 assert.equal((await verifySession(token,sessionSecret,now)).expiresAt,dayWindow(now).expiresAt);
 assert.equal(await verifySession(token+'x',sessionSecret,now),null);
 assert.equal(await verifySession(token,secret,now),null);
 assert.equal(await verifySession(token,sessionSecret,dayWindow(now).expiresAt),null);
 assert.equal(await verifySession(token,sessionSecret,now-86400000),null);
 assert.equal(await verifySession('x'.repeat(9000),sessionSecret,now),null);
});
test('return destination accepts app links but excludes external and auth destinations',()=>{
 assert.equal(safeReturnPath('/?view=1&tab=dashboard'), '/?view=1&tab=dashboard');
 for(const bad of ['https://evil.test','//evil.test','/\\evil.test','/auth/login','/%61uth/logout','/auth/../auth/login','/\r\nevil'])assert.equal(safeReturnPath(bad), '/?view=1&tab=dashboard');
});
