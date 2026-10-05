# 浏览器计算 T1 契约（2026-10-04）

T4 于 2026-10-05 核定的唯一通信扩展：超过 4096 行的结果通过内部 `result-part` 分批传输，每批不超过 1024 行，包含 `{type,requestId,offset,totalRows,rows}`；最后 `result` 消息包含 `rowCount` 与六字段 Result 的头部（其 `rows:[]`）。客户端检查顺序/数量并装配全部行后才调用 `onResult({requestId,result})`。缺失、乱序、超量、任务过期或取消均不提交。小结果保留原完整 `result` 消息。公开 Input、Result、Progress、Error 与数值容差不变；这不是新的算法结果格式。原因是年度完整结构一次性传回实测造成 2.6—2.9 秒主线程停顿。构建/生命周期/性能证据见 T4 报告。

本文件冻结 T2/T3 的交接边界。Python 基线为 `a30816b43e265ac6f23faa549bb26a6ddbcf28b2` 下的 `upload_pipeline.py`、`threshold_allocation.py`、`curtailment.py`，三者未修改。可执行字段校验位于 `dashboard/src/content/calculation/contracts.mjs`；完整输出保持原有六个顶层字段，不沿用 T0 界面样例的裁剪。

## 1. 输入、限制与时间

```js
InputFile = {name: string, bytes: ArrayBuffer}
Options = {capacity: number, stationName: string, start: string|null, end: string|null}
Input = {power: InputFile[], forecast: InputFile[], options: Options}
```

`bytes` 是未经转换的原文件字节，名称包括扩展名。支持 CSV、XLSX、内容为 OOXML 的 XLS；旧二进制 XLS 不支持。每类 1—400 个文件，总字节数不超过 60,000,000，空文件拒绝；每个工作簿解压后最多 150,000,000 字节。容量是有限正数 MW，不能把布尔值或字符串直接当容量。表格内数字转换则遵循 Python `number`：空值、布尔、非数值和非有限值为 null；有限数字字符串可接受。

起止日期只接受合法的 `YYYY-MM-DD` 或 null。日期范围首尾均包含，1—366 天；null 表示后续从分钟数据推定。若末条功率是次日 00:00 且不是唯一时间，则它作为上一日端点，不额外推定一个完整报告日。显式范围与推定范围都须在分析层复查。输入契约校验不读取表格，不替代这次复查。

所有计算以固定 UTC+08 为准，不能使用浏览器所在时区。内部 Map 键为整数 epoch 毫秒；输出时间为 `YYYY-MM-DDTHH:mm:00+08:00`。无偏移时间视为 +08；带偏移时间先转为 +08；非零秒或小数秒拒绝，不能四舍五入。基线支持的 ISO/斜线日期算例见 `times.json`。Excel 1900/1904 日期系统由读取器处理；读取器的 Date 表示 **UTC 编码的表格墙钟时间**，T2 用其 UTC 年月日时分再按 +08 解释，不能当作真实 UTC 时刻直接换时区。

数据下载表的预测时间是版本时刻，第二点目标 = 版本 +15 分钟。精确节点优先；其余分钟仅在相邻且恰好相隔 15 分钟的节点间线性插值。不得外推或跨缺点；无匹配返回 `{f:null}`，其他预测字段不存在。精确节点的左右节点、版本、来源相同，权重为 0。负值或超过容量的左右端点使该分钟被排除，即使插值值本身在范围内。

## 2. 输出 Result

```js
Result = {meta, summary, daily, gaps, rows, calibration}
```

不增加顶层字段，不删除 calibration。T1 没有额外版本字段，也没有可被比较器忽略的字段。将来增加版本必须明确审核，不能偷偷加入忽略列表。

| 部分 | 必需字段与语义 |
|---|---|
| meta | stationId、stationName、forecastNodes、forecastDuplicates、blankForecastRows、capacity、start、end、timezone、powerRows、powerDuplicates、powerOutsidePeriod、negativePolicy、thresholds、files |
| summary | 下列 10 个电量字段、8 个计数字段、coverage、dispatchShare |
| daily[] | date 加 summary 的全部字段；按日排序，每日完整 1440 分钟 |
| gaps[] | start、end、minutes、reason；每个原因独立合并，半开区间 `[start,end)`；按 start 再按原因 Unicode 顺序排列 |
| rows[] | 全日期范围每分钟一行，按时间升序，缺失分钟也保留 |
| calibration | referenceTotal、assigned、difference、relativeDifference、releasedAboveAgc、noiseAbove、unexplainedAbove、closureError |

10 个电量字段均为 **MWh**：dispatch、prediction、other、above、below、gap、noiseAbove、noiseBelow、operationalBelow、unexplainedAbove。分钟行中的电量已经除以 60；汇总只求和，不再次除以 60。

8 个整数计数：expected、included、excluded、negativeActual、missingForecast、missingPower、baselineAnomalies、special。不同排除原因可能重叠，不能相加当作唯一缺失时间；included + excluded = expected。coverage = included/expected。dispatchShare = dispatch/(dispatch+prediction)，分母为零时 null。负实发整分钟排除，不补零；实发高于可用但未超过容量的分钟仍参与，正差额计零并加注基准异常。

meta.files 按输入顺序保留 **功率文件后预测文件**：`{name,bytes,sha256}`，哈希基于原始文件字节。相同重复数据保留第一次的文件和物理行来源并累计重复数；冲突拒绝。不把事后新版本替换原采用版本。预测空数值跳过，但行的场站 id 仍参与单场站校验。

thresholds 固定为百分数（不是小数比例）：AGC 下限 2、调度进入 1/退出 0.5、跟随 1、预测空间进入 2/退出 1、指令以下其他差额 0.5。进入/维持使用严格 `>`，跟随使用 `<=`，不添加 epsilon 改变阈值。跨日延续状态；任何被排除分钟重置状态。

### 分钟行的条件字段

每行始终有：timestamp、date、time、minute（0—1439）、a、f、g、p、theory、included、reasons、status、note 和 10 个电量字段。a/f/g/p/theory 是 MW 或 null；theory 不参与两类归因。reasons 是有序字符串数组，不排序改写。status 只取 estimated/excluded；当前可计算行仍为估算口径。

| 条件 | 字段存在规则 |
|---|---|
| 有功率记录 | powerSource 存在，形如 `文件名 第 2 行`；缺行时不存在 |
| f 非 null | version、rightVersion、target、rightTarget、leftF、rightF、weight、forecastSource、rightForecastSource 全部存在；端点为 MW，weight 为无量纲 |
| f 为 null | 上述 9 个字段全部不存在，不能补 null |
| included=true | 10 个电量为有限非负数；另有 referenceTotal、releasedAboveAgc（MWh）、dispatchState、predictionState、following、floorFollowing（布尔）、trackingReference（MW）、allocationBands |
| included=false | 10 个电量全部 null；上述审计电量、状态、trackingReference、allocationBands 全部不存在 |

allocationBands 为有序数组 `{kind,bottom,top}`；kind 取 other/dispatch/prediction，纵轴 bottom/top 是 MW、top > bottom。数组顺序沿用 Python。面积乘 1/60 小时才是 MWh；不能把电量当作阴影高度。

calibration 是内部校核，保留完整输出用于迁移核验，暂不增加网页展示。difference 和 closureError 可为负；relativeDifference 分母零时 null。两类归因、剩余差额、实际超过指令的修正项保持 Python 的计算次序。

## 3. 模块边界、错误与进度

T2 的标准化返回 `{power:Map,forecasts:Map,metadata}`。power 值为 `{a,p,g,theory,powerSource}`；forecasts 值为 `{value,version,source}`。重复功率计数可用 metadata.powerDuplicates 传给 T3，其他预测元数据保持 Python 字段。标准化样例单独保存 powerDuplicates 以明确其基线来源。禁止拿表格阅读器直接分类。

T3 `analyzeNormalized(normalized,options)` 同步返回完整 Result；后续 `analyzeFiles(input,onProgress)` 调同一个分类实现，返回 Promise<Result>。T4 Worker 请求 `{type:'calculate',requestId,input}`；进度、结果、错误回包都带同一 requestId。取消通过终止 Worker 完成，不以过期结果表示取消。

Progress：`{requestId,phase,completed,total}`；requestId 是非空字符串，phase 为 reading/validating/calculating/aggregating，completed/total 为非负整数且 completed <= total。total=0 可用于未知工作量的阶段开始，后续再设置真实总量；不得伪造计算完成百分比。

Error：`{code,message,file?,row?,field?}`。code 为 INPUT/TABLE/TIME/DUPLICATE/STATION/RANGE/RESOURCE/INTERNAL。文件类型/表头问题为 TABLE，时间解析为 TIME，重复冲突为 DUPLICATE，多场站为 STATION，日期范围为 RANGE，资源超限为 RESOURCE，其他无数据/参数问题为 INPUT，未预期内部错误为 INTERNAL。message 保持基线的可读中文信息；已知物理行号从 2 开始，缺乏定位信息时省略可选字段，不能猜测行号。

manifest 中 error.type=ValueError 记录 **Python 异常类型**，不属于 Worker Error。后续比较业务错误使用 `{code,message}`；如增加定位字段，另测其正确性。冻结的 8 个错误算例有明确 code/message，不采用模糊的“包含关键字就算通过”。

## 4. 比较与样例使用

`tests/browser/compare.mjs` 的 `compareResults(expected,actual)` 返回 equal、first、differences、maxMinuteError、maxAggregateEnergyError。差异包括路径、类型、期望/实际、字段是否存在；分钟差异另带 timestamp 和 a/f/g/p。先验证 Result 再比较，避免两份同样错误的对象被视为合格。

| 字段 | 绝对容差 |
|---|---:|
| rows 的功率、端点、权重、审计电量、10 个电量、阴影高度 | 1e-9，单位随字段 |
| summary/daily/calibration 的电量 | 1e-6 MWh |
| coverage、dispatchShare、relativeDifference | 1e-9，无量纲 |
| 时间、状态、原因、备注、计数、容量、阈值、文件字节数、哈希、其他字段 | 精确相等 |

不强制转型；额外字段也失败；字段不存在与 null 不等价；数组顺序必须一致。比较器返回全部差异并保留第一个，没有悄悄截断或扩大容差。T2 单独比对插值时可将算例转换为 `{rows:[{timestamp,...插值字段}]}` 以应用相同分钟字段容差；标准化 Map 比较则按精确元数据和数值字段分开测试。

样例目录为 `tests/fixtures/browser/contract/`，只含合成数据：28 个输入场景（19 个完整 Result，其中包含 56 MW 全日 1440 分钟完整覆盖；8 个致命错误、1 个 366 天边界）、12 个独立手算/滞回序列、逐单元格表格期望、标准化/插值期望及时间样例。manifest 记录冻结提交、Python/openpyxl 版本、每个文件原始 SHA-256，以及 3 个 Python 源文件的 LF 规范化 SHA-256。工作簿 ZIP 和 gzip 时间固定，CSV 明确按二进制检出。

366 天样例实际执行 Python 的 527,040 分钟完整计算，存储 meta/summary/daily/gaps/calibration 投影而省去重复的 rows；不能把该投影当作完整 Result。其他 19 份结果保留六个字段和所有分钟行，测试不裁剪。边界样例证明 Python 日期范围接受能力；**尚未证明浏览器 366 天计算或内存/渲染性能**，这些在 T4 实测。

`numbers.json` 另外固定 Python 的数值转换，包括正号、下划线及 Unicode 十进制数字。这些是基线兼容边界，不要求界面鼓励这种输入；T2 不能仅用 JS `Number` 或当前正则替代 Python 行为。容量 Options 仍仅接受 number。

显式更新期望：`python tests/generate_browser_fixtures.py`。生成器先验证冻结基线源代码一致，再生成；不扫描真实数据目录。测试命令不生成、不更新任何期望：

```text
python -m unittest discover -s tests -p "test_*.py"
node --test tests/browser/contracts.test.mjs
node tests/browser/audit-table-oracle.mjs reports/browser-review/T1/table-audit.json
```

生成器更新后必须审阅 Git 差异和 manifest，不能为通过测试而重写对照值。输入/表格/标准化样例可供 T2 使用，allocator.json 和完整 Result 供 T3 使用；两者通过全量对照后才进入 G1 审核。

### T1 发现并移交 T2 的日期读取缺陷

`contracts.test.mjs` 验证契约/比较器/固定期望，并核对 CSV 及非日期单元格工作簿。**全单元格**对照由独立 `audit-table-oracle.mjs` 执行，不绕过日期差异；尚未修复时返回非零退出码。

锁定库 `read-excel-file@9.3.10` 的 `modules/xlsx/parseExcelTimestamp.js` 最后使用 `Math.floor((excelSerialDate-daysBeforeUnixEpoch)*DAY)`；Python openpyxl `from_excel` 对一天的小数部分舍入到毫秒。新合成日期单元格暴露 `00:15:00` 被读成 `00:14:59.999`。固定期望保留 Python 的 `00:15:00`，不改成错误值，也不扩大容差。

T2 必须先修复原始 Excel 日期序列转换，支持 1900/1904 日期系统，并增加真实非零秒/毫秒仍被拒绝的反例。不能在最终 Date 上统一取整到分钟，不能靠统一加一天修补，更不能只允许这几个文件例外。库没有公开日期解析回调，具体适配方式需在 T2 实现时审查；禁止直接修改 node_modules。T3 可以先执行独立的分类/汇总迁移；在日期审计通过前，T2 不算完成，G1 全流程对照不能放行。

该审计也比较 numbers.json：现有 numberOrNull 的正则未接受正号、下划线、Unicode 十进制数字。T2 数值标准化必须对上 Python，不使用为绕过测试而设的文件/值白名单。这项和日期问题都属于读取兼容性，不能通过修改限电公式解决。
