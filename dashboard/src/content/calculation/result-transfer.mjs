/** Private, bounded transport; public onResult still receives the full Result. */
export const RESULT_PART_ROWS=1024;
export const RESULT_PART_THRESHOLD=4096;
export function postCalculationResult(scope,requestId,result) {
  if(result.rows.length<=RESULT_PART_THRESHOLD){scope.postMessage({type:'result',requestId,result});return;}
  const {rows,...header}=result,rowCount=rows.length;
  for(let offset=0;offset<rowCount;offset+=RESULT_PART_ROWS) {
    const part=rows.slice(offset,offset+RESULT_PART_ROWS);
    scope.postMessage({type:'result-part',requestId,offset,totalRows:rowCount,rows:part});
    // The Worker owns this result exclusively. Release sent objects, without
    // mutating the calculation core or exposing partial data to its caller.
    rows.fill(null,offset,offset+part.length);
  }
  scope.postMessage({type:'result',requestId,rowCount,result:{...header,rows:[]}});
}
