/** A narrow adapter for an upstream millisecond-floor defect, not an XLSX reader.
 * read-excel-file still decides cell types and parses styles/formula caches.
 * Only its Date cells are corrected from the selected sheet's original values.
 */
import {Parser} from 'saxen';
const DAY=86_400_000;
function parseXml(xml,open,close=()=>{},text=()=>{}) {
  const parser=new Parser();
  parser.on('error',e=>{throw e;});parser.on('warn',e=>{throw e;});
  parser.on('openTag',(name,get,decode)=>{
    const attrs=Object.fromEntries(Object.entries(get()).map(([key,v])=>[key.split(':').at(-1),decode(v)]));
    open(name.split(':').at(-1),attrs);
  });
  parser.on('closeTag',name=>close(name.split(':').at(-1)));
  parser.on('text',(v,decode)=>text(decode(v)));parser.on('cdata',text);
  parser.parse(xml);
}
export function workbookMetadata(xml) {
  const sheets=[];let activeTab=0,date1904=false;
  parseXml(xml,(tag,a)=>{if(tag==='sheet')sheets.push(a.name);else if(tag==='workbookView')activeTab=Number(a.activeTab??0);else if(tag==='workbookPr')date1904=['1','true'].includes(a.date1904);});
  return {sheets,activeTab:Number.isInteger(activeTab)&&activeTab>=0&&activeTab<sheets.length?activeTab:0,date1904};
}
export function worksheetPart(workbookXml,relationshipsXml,sheetName) {
  let id,target;
  parseXml(workbookXml,(tag,a)=>{if(tag==='sheet'&&a.name===sheetName)id=a.id;});
  parseXml(relationshipsXml,(tag,a)=>{if(tag==='Relationship'&&a.Id===id&&a.TargetMode!=='External')target=a.Target;});
  if(!target)throw new Error('所选工作表关系缺失');
  const url=new URL(target,'https://ooxml.invalid/xl/workbook.xml');
  if(url.origin!=='https://ooxml.invalid'||url.search||url.hash)throw new Error('工作表路径无效');
  return url.pathname.slice(1);
}
function roundEven(x) {const floor=Math.floor(x),fraction=x-floor;return fraction>.5||(fraction===.5&&floor%2!==0)?floor+1:floor;}
export function excelSerialToDate(serial,date1904=false) {
  if(!Number.isFinite(serial))throw new Error('Excel 日期序列无效');
  let days=Math.floor(serial);const ms=roundEven((serial-days)*DAY);
  if(!date1904&&serial>0&&serial<60)days++;
  return new Date((date1904?Date.UTC(1904,0,1):Date.UTC(1899,11,30))+days*DAY+ms);
}
export function correctExcelDates(rows,sheetXml,date1904) {
  let cell=null,inValue=false;
  parseXml(sheetXml,(tag,a)=>{
    if(tag==='c') {
      cell=null;const m=/^([A-Z]+)(\d+)$/.exec(a.r??'');if(!m)return;
      let col=0;for(const c of m[1])col=col*26+c.charCodeAt(0)-64;
      const row=Number(m[2])-1;col--;
      if(rows[row]?.[col] instanceof Date&&(a.t===undefined||a.t==='n'))cell={row,col,value:''};
    } else if(tag==='v'&&cell)inValue=true;
  },tag=>{
    if(tag==='v')inValue=false;
    if(tag==='c'&&cell) {
      const serial=Number(cell.value);if(!cell.value.trim()||!Number.isFinite(serial))throw new Error('Excel 日期序列无效');
      const date=excelSerialToDate(serial,date1904);
      // openpyxl returns datetime.time for a serial within the first day.
      // Preserve its string form: a bare clock is not a reporting timestamp.
      const ms=roundEven((serial-Math.floor(serial))*DAY);
      rows[cell.row][cell.col]=serial>=0&&serial<1&&ms<DAY
        ?date.toISOString().slice(11,19)+(date.getUTCMilliseconds()?'.'+String(date.getUTCMilliseconds()*1000).padStart(6,'0'):'')
        :date;
      cell=null;
    }
  },value=>{if(cell&&inValue)cell.value+=value;});
  return rows;
}
