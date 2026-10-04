"""Read-only differential oracle over the actual unchanged Python implementation.
Input arrives on stdin; no fixture or expected file is regenerated.
"""
import base64, json, sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from threshold_allocation import ThresholdAllocator
from upload_pipeline import analyze_uploads, parse_time, number

request=json.load(sys.stdin)
mode=request['mode']
if mode=='allocator':
    model=ThresholdAllocator(request['capacity'],request.get('scale',1))
    rows=[]
    for row in request['rows']:
        if row.get('reset'):
            model.reset();rows.append({'reset':True})
        else:rows.append(model.calculate(row['a'],row['f'],row['g'],row['p']))
    result={'rows':rows}
elif mode=='scalars':
    times=[]
    for value in request['times']:
        try:times.append({'input':value,'expected':parse_time(value).isoformat()})
        except ValueError as error:times.append({'input':value,'error':str(error)})
    result={'times':times,'numbers':[{'input':v,'expected':number(v)} for v in request['numbers']]}
else:
    def files(items):return [(x['name'],base64.b64decode(x['bytes'])) for x in items]
    o=request['input']['options']
    try:
        result=analyze_uploads(files(request['input']['power']),files(request['input']['forecast']),
            capacity=o['capacity'],station_name=o['stationName'],start=o['start'],end=o['end'])
    except ValueError as error:result={'error':str(error)}
    if request.get('projection') and 'error' not in result:
        result={key:result[key] for key in request['projection']}
print(json.dumps(result,ensure_ascii=False,allow_nan=False,separators=(',',':')))
