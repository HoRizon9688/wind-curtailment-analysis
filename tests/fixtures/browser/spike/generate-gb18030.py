"""Write the GB18030 spike fixture.

Node cannot encode text as GB18030, so this one fixture needs Python. Synthetic
values only; it renders the same rows as the UTF-8 CSV.
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent

ROWS = [
    ['时间', '可用功率', '理论功率', '全站总有功_集电线有功之和', 'AGC有功设定值'],
    ['2026/8/1 0:00', '', '29.6', '28.9', '21'],
    ['2026/8/1 0:01', '29.6', '29.7', '29', '21.1'],
    ['2026/8/1 0:02', '29.7', '29,7', '29.1', '21.2'],
]

def render(rows):
    """Quote only the cells that need it, so quoting itself is under test."""
    def cell(value):
        text = '' if value is None else str(value)
        return '"' + text.replace('"', '""') + '"' if any(c in text for c in ',"\r\n') else text
    return '\r\n'.join(','.join(cell(value) for value in row) for row in rows) + '\r\n'


if __name__ == '__main__':
    text = render(ROWS)
    target = HERE / 'minute-power-gb18030.csv'
    target.write_bytes(text.encode('gb18030'))
    print(f'wrote {target.name} ({len(target.read_bytes())} bytes)')
