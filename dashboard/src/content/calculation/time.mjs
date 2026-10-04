import {CalculationError} from './errors.mjs';
import {stripText,pythonString} from './scalar.mjs';
export {stripText} from './scalar.mjs';
export const MINUTE_MS=60_000;
export const QUARTER_MS=900_000;
export const DAY_MS=86_400_000;
const OFFSET_MS=28_800_000;
const pad=(v,n=2)=>String(v).padStart(n,'0');

function calendar(y,m,d) {
  if(y<1||y>9999||m<1||m>12||d<1)return null;
  const date=new Date(0);date.setUTCFullYear(y,m-1,d);date.setUTCHours(0,0,0,0);
  return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d?date.getTime():null;
}
function isoDate(text) {
  let m=/^(\d{4})-?(\d{2})-?(\d{2})/.exec(text);
  // Separators in calendar dates must be both present or both absent.
  if(m && (/^\d{4}-\d{2}-\d{2}/.test(text)||/^\d{8}/.test(text)))return {base:calendar(+m[1],+m[2],+m[3]),length:m[0].length};
  m=/^(\d{4})(?:-W(\d{2})(?:-(\d))?|W(\d{2})(\d)?)/.exec(text);
  if(!m)return null;
  const year=+m[1],week=+(m[2]??m[4]),weekday=+(m[3]??m[5]??1);const jan4=calendar(year,1,4);
  if(jan4===null||week<1||week>53||weekday<1||weekday>7)return {base:null,length:m[0].length};
  const monday=jan4-((new Date(jan4).getUTCDay()+6)%7)*DAY_MS;
  const base=monday+((week-1)*7+weekday-1)*DAY_MS;
  const thursday=base+(4-weekday)*DAY_MS;
  return {base:new Date(thursday).getUTCFullYear()===year?base:null,length:m[0].length};
}
function clock(text) {
  const m=/^(\d{2})(?:(?::(\d{2})(?::(\d{2}))?)|(\d{2})(\d{2})?)?(?:[.,](\d+))?$/.exec(text);
  if(!m)return null;
  const h=+m[1],mi=+(m[2]??m[4]??0),s=+(m[3]??m[5]??0),us=+((m[6]??'').slice(0,6).padEnd(6,'0'));
  return {h,mi,s,us};
}
function dateText(date) {
  const y=pad(date.getUTCFullYear(),4),m=pad(date.getUTCMonth()+1),d=pad(date.getUTCDate());
  return `${y}-${m}-${d} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`+
    (date.getUTCMilliseconds()?`.${pad(date.getUTCMilliseconds()*1000,6)}`:'');
}

/** Epoch ms; Date cells encode naive Excel wall time with UTC getters. */
export function parseTime(value) {
  const display=value instanceof Date?dateText(value):stripText(value);
  const invalid=()=>{throw new CalculationError('TIME',`无法识别时间：${display}`);};
  const unaligned=()=>{throw new CalculationError('TIME',`时间必须精确对齐分钟，不能自动取整：${value instanceof Date?display:pythonString(value)}`);};
  if(value instanceof Date) {
    if(!Number.isFinite(value.getTime()))return invalid();
    if(value.getUTCSeconds()||value.getUTCMilliseconds())return unaligned();
    return value.getTime()-OFFSET_MS;
  }
  const text=display;
  const plain=/^(\d{4})([/-])(\d{1,2})\2(\d{1,2}) (\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(text);
  let base,parts,offsetUs=OFFSET_MS*1000;
  if(plain) {
    base=calendar(+plain[1],+plain[3],+plain[4]);parts={h:+plain[5],mi:+plain[6],s:+(plain[7]??0),us:0};
  } else {
    const date=isoDate(text);if(!date)return invalid();base=date.base;
    const rest=text.slice(date.length);
    if(!rest)parts={h:0,mi:0,s:0,us:0};
    else {
      // datetime.fromisoformat accepts any one-character date/time separator.
      const time=rest.slice([...rest][0].length);
      const match=/^(.*?)(Z|[+-]\d{2}(?::?\d{2})?(?::?\d{2})?(?:[.,]\d+)?)?$/.exec(time);
      parts=clock(match?.[1]??'');
      if(match?.[2]) {
        const off=match[2];
        if(off==='Z')offsetUs=0;
        else {
          const p=clock(off.slice(1));if(!p)return invalid();
          offsetUs=((p.h*3600+p.mi*60+p.s)*1_000_000+p.us)*(off[0]==='-'?-1:1);
          if(Math.abs(offsetUs)>=DAY_MS*1000)return invalid();
          // Python treats an all-zero h/m/s offset as UTC, including its fraction.
          if(p.h===0&&p.mi===0&&p.s===0)offsetUs=0;
        }
      }
    }
  }
  if(base===null||!parts||parts.h>23||parts.mi>59||parts.s>59)return invalid();
  const shiftedUs=(parts.h*3600+parts.mi*60+parts.s)*1_000_000+parts.us-offsetUs+OFFSET_MS*1000;
  if(shiftedUs%60_000_000!==0)return unaligned();
  const epoch=base+(shiftedUs/1000)-OFFSET_MS;
  const year=new Date(epoch+OFFSET_MS).getUTCFullYear();if(year<1||year>9999)return invalid();
  return epoch;
}

export function formatTime(epochMs) {
  if(!Number.isFinite(epochMs)||!Number.isInteger(epochMs)||epochMs%MINUTE_MS!==0)throw new CalculationError('TIME','时间必须精确对齐分钟，不能自动取整');
  const local=new Date(epochMs+OFFSET_MS);
  const year=local.getUTCFullYear();if(year<1||year>9999)throw new CalculationError('TIME','时间超出有效日历范围');
  return `${pad(year,4)}-${pad(local.getUTCMonth()+1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:00+08:00`;
}
