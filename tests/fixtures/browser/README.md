# T0-R browser fixtures

All files here are **synthetic**. Nothing is derived from a real station, a real
forecast export or a real report. The generators only write computed or literal
values, and `tests/fixtures/browser/spike/python-baseline.py` reads the same
workbooks with openpyxl (the production baseline) so the browser adapter can be
compared against it rather than against an assumption.

## `spike/` — table adapter fixtures

Regenerate with:

```sh
node tests/fixtures/browser/spike/generate.mjs
python tests/fixtures/browser/spike/generate-gb18030.py
```

Regeneration is byte-identical (ZIP timestamps pinned), so the hashes below are
stable. The GB18030 file needs Python because Node cannot encode that charset.

| File | Purpose | SHA-256 | Bytes |
|---|---|---|---:|
| `minute-power.csv` | UTF-8 + BOM minute table; row 2 has an empty `可用功率`, row 4 an embedded comma | `b15169f550dc7c85a7c036ea6a51ab297c64ebdd887cdc2a2cfaab3ad7f3592b` | 193 |
| `minute-power-gb18030.csv` | Same rows as GB18030, for the decode fallback | `6d2cdc54d3fc013ad4cef4f139d0c6b876ae8fa5f97a21d865093d9113d963f8` | 163 |
| `forecast-ooxml.xls` | Real OOXML named `.xls`; sheet `功率预测`, shared + inline strings, cached and uncached formulas, date cells (1900) | `8d91a5b096ff8a910c640bf89f6dda7fdd7c157eb90ba9904924c9c9e086ab78` | 3053 |
| `minute-power-ooxml.xlsx` | Date-formatted cells beside plain numbers in the same column | `e06a644798f3051d4429a2fa1b765231f9cc08dc95108cb59be1ac03dbe61a09` | 3249 |
| `forecast-1904.xlsx` | Same content with `date1904="1"`; openpyxl reads 2030-08-01, i.e. +1462 days | `c483d38b6acfb97b71f19a9cef3feab877437895a6b4e0918e3cf7cc8d8dcdd0` | 3065 |
| `forecast-no-power-sheet.xls` | No `功率预测`; `activeTab=0`, so the first sheet is read | `d39d070f5a2eb8feec6aecee4e6c44900c8f197be888075716b583752a50d053` | 3031 |
| `forecast-active-second.xlsx` | Cover sheet first, real table on the **active second** sheet — the regression the coordinator found. openpyxl reads `分钟数据` | `3e93d22ce7fde6c0aec7a1eb46568fb86c3de5e03bfa53155b245fdc114b8c83` | 3106 |
| `forecast-active-first.xlsx` | Same layout with the cover active, so the fallback must follow `activeTab` | `a597134c3f111f884e1eab9118d28632e5687875a22774a3a0672d62ae7bf578` | 3108 |
| `bounds-wide.xlsx` | Value in the last legal column `XFD` (index 16384) | `61fa994f9ff9442ee47e9195b1600cd91a21c767cc433a7dd94975441456ffff` | 2869 |
| `gaps.xlsx` | Empty middle cells, pinning the row-compaction both readers share | `e2be7042545022cc4a77587ba086d0baa8f9251708bb435ccd28fc75198fea92` | 2817 |
| `no-workbook.xlsx` | Valid zip that is not a workbook (no `xl/workbook.xml`) | `3e3045c57af59a0a0b364eebf42ca52c0119e6390b6fb5f0cf737eead4a53ec2` | 538 |
| `corrupt.xlsx` | Truncated OOXML package | `9bf118084a7101d8e8b25ac2af299a0dd01c9d271e1f889aff37d00084c059d8` | 900 |
| `legacy-binary.xls` | OLE2 magic `D0CF11E0A1B11AE1`; must keep raising the existing error | `be7ba2b6815ac6866f093484fd0dd09830b681e987ad6edf19a2dcf7a8663425` | 2056 |
| `not-a-workbook.xlsx` | Plain text pretending to be a workbook | `03688215438e62b464e111d76ca26a7990f11302ff107939747d5d3439c53662` | 39 |

Properties pinned by these fixtures:

- the cached `<v>` is used for formulas; a formula without `<v>` stays `null` and is **never** evaluated;
- empty cells survive as `""` (CSV) or `null` (OOXML) instead of shifting columns;
- dates follow the workbook date system and are recognised from the number format;
- OOXML is detected from content, so the `.xls` extension keeps working;
- worksheet selection is preferred-sheet → **active** sheet → first sheet;
- legacy binary XLS keeps failing exactly as `upload_pipeline.table_rows` does.

## `analysis-a.json.gz` / `analysis-b.json.gz` — shell A/B fixtures

Two complete synthetic analyses produced by the **baseline** pipeline
(`upload_pipeline.analyze_uploads`), not by hand, so the shell test renders
genuine result objects:

```sh
python tests/fixtures/browser/generate-analysis-fixtures.py
```

| File | Station | Day | Capacity | SHA-256 | Bytes (gzip) |
|---|---|---|---|---:|---:|
| `analysis-a.json.gz` | 合成甲场站 | 2026-01-01 | 56 MW | `4d7c5f2520b5b4f0e3764534c032177d4b03b5325aae5fd282293d516ccea431` | 126144 |
| `analysis-b.json.gz` | 合成乙场站 | 2026-02-01 | 100 MW | `6fe47cc2e2d7d9c2fa80e557cf9be246d0bf29e9d467b0e93d27eadee5ed7523` | 128792 |

They are gzipped so the committed fixture stays small while
`tests/browser/shell-ab/run.mjs` needs Node only — not Python — to reproduce the
whole-shell verification. Each is ~1.9 MB of JSON.

## `spike/python-baseline.py`

Prints what openpyxl sees in each workbook (active sheet, chosen sheet, header
row, first data row with value types). This is the reference the adapter is
compared against.

```sh
python tests/fixtures/browser/spike/python-baseline.py
```
