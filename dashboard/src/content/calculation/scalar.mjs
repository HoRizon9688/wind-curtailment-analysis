/** Scalar conversions for CSV/OOXML cells. No JS object/hex/boolean coercion. */
export function pythonString(v) {return v===null||v===undefined?'None':v===true?'True':v===false?'False':String(v);}
export function stripText(v) {return pythonString(v).replace(/^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu,'');}
const NUMERIC=/^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;
function asciiDigit(ch) {
  const code=ch.codePointAt(0);
  if(code<128||!/^\p{Nd}$/u.test(ch))return ch;
  // Adjacent Unicode decimal blocks (e.g. mathematical fonts) have multiples
  // of ten characters. Nd is required: do not accept superscripts via NFKC.
  let first=code;while(/^\p{Nd}$/u.test(String.fromCodePoint(first-1)))first--;
  return String((code-first)%10);
}
export function numberOrNull(v) {
  if(typeof v==='number')return Number.isFinite(v)?v:null;
  if(typeof v!=='string')return null;
  const trimmed=v.replace(/^\p{White_Space}+|\p{White_Space}+$/gu,'');
  const text=/[^\x00-\x7f]/.test(trimmed)?Array.from(trimmed,asciiDigit).join(''):trimmed;
  if(!NUMERIC.test(text))return null;
  const parsed=Number(text.replaceAll('_',''));return Number.isFinite(parsed)?parsed:null;
}
