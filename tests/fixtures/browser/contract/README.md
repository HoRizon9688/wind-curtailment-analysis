# T1 纯合成对照样例

所有时间、场站名和功率由 `tests/generate_browser_fixtures.py` 定义；没有读取用户的场站表。生成命令只手动执行，测试从本目录读取固定期望。

| 文件/场景 | 用途 |
|---|---|
| manifest.json | 冻结源提交、Python/openpyxl 版本、源代码及生成文件 SHA-256、场景/输入/参数/期望索引 |
| allocator.json | 12 组分类和滞回序列，含完整 Python 返回与独立手算检查 |
| tables.json | 56 个输入文件逐单元格期望；Excel 日期以 excelWallTime 标识墙钟时间，不混作真实 UTC |
| normalized.json | 去重后的功率/预测映射、计数、来源和采样分钟插值期望 |
| times.json | 无偏移/+08/Z/+09/斜线日期，非零秒/毫秒及坏日期错误期望 |
| numbers.json | Python 数值转换基线，包含正号、下划线、Unicode 数字、空值、布尔和非有限值 |
| normal、both、floor | 正常跟随、两类并存、2% AGC 下限/明显高于预测、实发超过指令和可用 |
| continuous-day-56mw | 56 MW 场站完整合成日，1440 分钟均可计算，覆盖跟随、下限、调度、明显高于预测与实发修正 |
| interpolation、missing-node、bad-endpoint | 逐分钟线性插值、禁止跨缺点、坏预测端点排除 |
| negative-and-reset、missing-and-reset、cross-midnight | 厂用电负实发、缺行重置、跨日滞回不重置 |
| invalid-values、blank-forecast | 缺数值/负值/超容量排除、空预测跳过 |
| utf8-bom-quotes、gb18030、ooxml-named-xls | 编码、引号内中文逗号、OOXML 假扩展名、首选工作表 |
| dates-1900-active-sheet、dates-1904 | 两种真实日期序列、活动表选择、稀疏空单元格 |
| duplicate-identical、duplicate-*-conflict | 重复一致去重/保留首个来源、重复冲突拒绝 |
| mixed-stations、missing-header、duplicate-header | 单场站规则、缺少必要列、重复列名 |
| seconds-not-rounded、forecast-not-quarter | 分钟及 15 分钟版本对齐，拒绝自动取整 |
| inferred-midnight-endpoint、range-366、range-367 | 次日零点端点推定、实际执行 527,040 分钟 Python 边界计算、超上限拒绝 |

19 个分析场景在 expected/*.json.gz 中保留 **完整六字段 Result**，包括所有分钟、被排除行、内部校核和条件字段。8 个致命错误保存在 manifest，不制造空成功结果。range-366 实际执行完整 Python 计算，仅存储 5 个审计字段的投影，显式省略 rows；不代表浏览器性能已经验收。

日期读取有已知 T2 待修复缺陷：锁定 JS 库在本样例中把 00:15:00 截成 00:14:59.999。`audit-table-oracle.mjs` 对所有单元格逐项审计并返回失败；不修改期望、不抹平秒值。详见 `docs/browser-calculation-contract.md`。

源 SHA-256 按 LF 规范化；输入字节 SHA-256 不能规范化。CSV、工作簿、gzip 按二进制检出；工作簿 ZIP 和内部修改时间、gzip 时间均固定。更新 Python 基线前，生成器会拒绝继续，不允许静默刷新期望。
