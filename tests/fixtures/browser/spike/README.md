# T0 spike fixtures

All files here are **synthetic**. Nothing in this directory is derived from a real
station, a real forecast export or a real report. The generator only writes
computed or literal values.

Regenerate (both commands, from the repository root):

```sh
node tests/fixtures/browser/spike/generate.mjs
python tests/fixtures/browser/spike/generate-gb18030.py
```

Regeneration is byte-identical: ZIP timestamps are pinned, so the SHA-256 values
below are stable. The GB18030 file needs Python because Node cannot encode any
charset other than UTF-8.

| File | Purpose | SHA-256 | Bytes |
|---|---|---|---:|
| `minute-power.csv` | UTF-8 + BOM minute table; row 2 has an empty `可用功率`, row 4 has an embedded comma | `b15169f550dc7c85a7c036ea6a51ab297c64ebdd887cdc2a2cfaab3ad7f3592b` | 193 |
| `minute-power-gb18030.csv` | Same rows encoded as GB18030, to exercise the decode fallback | `6d2cdc54d3fc013ad4cef4f139d0c6b876ae8fa5f97a21d865093d9113d963f8` | 163 |
| `forecast-ooxml.xls` | Real OOXML package named `.xls`; sheet `功率预测`, shared + inline strings, cached and uncached formulas, date cells | `8d5d3c79ae8dc57073151fd61bdd361569b2f49383c02e12b83052da3793b40f` | 3018 |
| `minute-power-ooxml.xlsx` | Date-formatted cells next to plain numbers in the same column | `f2aa4e45a79aceec2bd2f462be1cdda295fc76cc7a493bffe59aaeaeea5609d3` | 3214 |
| `forecast-1904.xlsx` | Same content with `date1904="1"` to pin the 1462-day offset | `b63ea937eb1b1050fd0cd2fa1b403dd60dbefb8429d5e003f3dc481dfb41c34d` | 3032 |
| `forecast-no-power-sheet.xls` | Workbook without `功率预测`, to prove the first-sheet fallback | `cbe4e06f779b9845662bb4554d227432d50320057450cea95593ea1e2f197cc6` | 2998 |
| `legacy-binary.xls` | OLE2 magic `D0CF11E0A1B11AE1`; must keep raising the existing error | `be7ba2b6815ac6866f093484fd0dd09830b681e987ad6edf19a2dcf7a8663425` | 2056 |
| `not-a-workbook.xlsx` | Plain text pretending to be a workbook | `03688215438e62b464e111d76ca26a7990f11302ff107939747d5d3439c53662` | 39 |

Key properties these fixtures pin down:

- cached `<v>` is used for formulas; a formula without `<v>` stays `null` and is **never** evaluated;
- empty cells survive as `""` (CSV) or `null` (OOXML) instead of shifting columns;
- dates are recognised by number format and converted with the workbook's date system;
- OOXML is detected from content, so the `.xls` extension keeps working;
- legacy binary XLS keeps failing exactly as `upload_pipeline.table_rows` does today.
