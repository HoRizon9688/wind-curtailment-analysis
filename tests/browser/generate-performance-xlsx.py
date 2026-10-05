"""Test-only: turn the harness-generated synthetic CSVs into dated OOXML.
No real files or frozen fixtures are read. Outputs are gitignored reports.
"""
import csv
from datetime import datetime
from pathlib import Path
from openpyxl import Workbook

folder=Path(__file__).resolve().parents[2]/'reports/browser-review/T4/xlsx-synthetic'
for kind,date_column in [('power',0),('forecast',2)]:
    book=Workbook(write_only=True)
    sheet=book.create_sheet('功率预测' if kind=='forecast' else '分钟功率')
    with (folder/f'synthetic-{kind}.csv').open(encoding='utf-8',newline='') as source:
        rows=csv.reader(source)
        sheet.append(next(rows))
        for row in rows:
            row[date_column]=datetime.fromisoformat(row[date_column])
            for i in ([1,2,3,4] if kind=='power' else [3]):row[i]=float(row[i])
            sheet.append(row)
    target=folder/f'synthetic-{kind}.xlsx'
    book.save(target)
    print(f'{target.name}: {target.stat().st_size} bytes')
