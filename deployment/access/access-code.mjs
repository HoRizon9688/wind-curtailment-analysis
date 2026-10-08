import {dailyCode,dayWindow} from './core.mjs';
import {readLocalSecrets} from './local-secrets.mjs';
try{
 const secret=process.env.DAILY_ACCESS_SECRET??readLocalSecrets().DAILY_ACCESS_SECRET;
 const code=await dailyCode(secret);console.log(`北京时间 ${dayWindow().date} 今日口令：${code}\n有效至次日 00:00。此命令只在管理员本机运行；请勿将密钥分享给访客。`);
}catch(e){console.error(e.message);process.exitCode=1;}
