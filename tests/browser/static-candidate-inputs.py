"""Convert only candidate synthetic CSVs into date-cell XLSX browser inputs."""
import csv,sys
from datetime import datetime
from pathlib import Path
from openpyxl import Workbook
root=Path(__file__).resolve().parents[2]
candidate=Path(sys.argv[1]).resolve()
assert candidate.is_relative_to((root/'reports/static-candidates').resolve())
out=root/'reports/browser-review/T6/xlsx-synthetic';out.mkdir(parents=True,exist_ok=True)
for name,column in [('minute-power',0),('forecast',2)]:
    with (candidate/f'site/samples/{name}.csv').open(encoding='utf-8-sig',newline='') as handle:rows=list(csv.reader(handle))
    wb=Workbook();ws=wb.active
    for i,row in enumerate(rows):
        if i:
            row[column]=datetime.fromisoformat(row[column])
            for j,value in enumerate(row):
                if j!=column:
                    try:row[j]=float(value)
                    except ValueError:pass
        ws.append(row)
    wb.save(out/f'{name}.xlsx')
print(out)
