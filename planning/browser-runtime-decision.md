# T0 决策记录：构建、文件解析与动态数据接入

日期：2026-09-29。基线提交：`26fd0e7ff436f92327063140f5352cd9b6466327`。
分支：`codex/browser-calculation`。阶段：T0（G0 待协调审核）。
规范依据：`docs/superpowers/specs/2026-09-29-browser-calculation-design.md`；执行计划：`docs/superpowers/plans/2026-09-29-browser-calculation.md`。

本文只记录验证结果与推荐决策。未修改 Python 计算口径，未发布，未改动任何真实数据，未绕过 `dashboard/AGENTS.md` 的保护。

---

## 1. 结论速览

| 问题 | 结论 |
|---|---|
| 表格解析是否需要新增 npm 依赖？ | **不需要**。平台内置能力（`DecompressionStream('deflate-raw')`、`TextDecoder`、`crypto.subtle`）已能覆盖 CSV/GB18030/OOXML 读取。 |
| 是否需要源码构建（`--source`）？ | **解析本身不需要**。新代码全部落在可编辑路径 `dashboard/src/content/calculation/`，普通构建即可静态导入。 |
| 动态替换整份分析快照是否可行？ | **当前不可行**。静态部署下没有任何内容层可达的快照/查询行替换通道，来源面板也无法由内容改写。 |
| 是否需要修改受保护文件？ | **需要，但范围很小**：2 个源文件 + 1 份完整性清单，详见 §5。**未获授权前不得修改。** |
| Worker 是否现在就要引入？ | **不需要**。31 天输入实测无 ≥50 ms 长任务，按 `AGENTS.md` 不得预防性引入 Worker。 |
| 隐私是否可控？ | 合成标记未出现在请求、存储或跨域调用中；受测页面零持久化写入。 |
| G0 是否通过？ | **不建议直接通过**。解析与构建路径已达标；动态接入路径缺失，属规范 §7「来源不一致的半成品」情形，须先由协调者核定 §5 清单。 |

---

## 2. 环境与基线（只读记录）

| 项目 | 值 |
|---|---|
| 基线 SHA / 分支 | `26fd0e7ff436f92327063140f5352cd9b6466327` / `main`，工作区干净 |
| `VERSION` | 0.2.0 |
| Python（含 openpyxl 3.1.5） | `C:/Users/HoRizon/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe`（3.12.14） |
| Node | `C:/Users/HoRizon/.workbuddy/binaries/node/versions/22.22.2-3/node.exe`（v22.22.2） |
| 浏览器 | HeadlessChrome/154（`C:/Program Files/Google/Chrome/Application/chrome.exe`） |
| Data 构建插件（`scripts/data-app.mjs`） | **本机未安装**，见 §6 未运行项 |

现有回归（本轮实测，未沿用历史「65 测试通过」说法）：

```text
python -m unittest discover -s tests -p "test_*.py"   → Ran 57 tests, OK
node --test tests/dashboard.test.mjs tests/upload-model.test.mjs → 8 pass / 0 fail
```

基线缺陷（与本轮改动无关，先记录不入代码）：

```text
node dashboard/scripts/verify-protected-runtime.mjs
→ Protected Data app runtime file is missing: .openai/hosting.json   (退出码 1)
node dashboard/scripts/verify-protected-runtime.mjs --authored-only .
→ Data app authored content verified.                                (退出码 0)
```

原因：`protected-runtime.json` 声明了 `.openai/hosting.json`，但 `.gitignore:18` 忽略 `/dashboard/.openai/`，因此**任何全新克隆都无法通过完整清单校验**。这是既有状态，我没有为了「让它通过」而改动清单或保护文件。建议由协调者在 T6 前决定：把该文件纳入版本库，或从清单职责中分离。

---

## 3. 解析依赖决策：不新增依赖

### 3.1 为什么不能加依赖

`dashboard/package.json` 与 `dashboard/package-lock.json` 都在 `protected-runtime.json` 的受保护清单内。`AGENTS.md` 明确普通构建「without network, dependency installation, npm, or project `node_modules`」，且源码构建「requiring compatible local Vite dependencies already installed」。因此**任何新 npm 依赖都会把项目推入源码构建 + 完整性清单重签流程**。

### 3.2 候选库实测对比

在隔离目录安装并实测（`README`-级证据见 §7 命令），对同一份手工构造 OOXML 工作簿：

| 候选 | 版本/许可 | 缓存公式 | 无缓存公式 | 空单元格 | 日期单元格 | 旧版二进制 XLS | 体积/依赖 |
|---|---|---|---|---|---|---|---|
| `read-excel-file` | 9.3.10 / MIT | 返回缓存值 `59` ✅ | `null` ✅ | `null` ✅ | `Date` ✅ | 显式拒绝 ✅ | 有 `./browser`、`./web-worker` 导出；依赖 fflate/saxen/unzipper-esm |
| `exceljs` | 4.4.0 / MIT | `{formula,result}` 需再归一化 | `{formula}` 无 result | 需再归一化 | `Date` ✅ | — | 23 MB，archiver/unzipper/tmp/jszip 等 Node 向依赖 |
| 平台内置（本方案） | 无依赖 | 取 `<v>` ✅ | `null` ✅ | `null` ✅ | 自算序列号 ✅ | 显式拒绝 ✅ | 0 依赖 |

三个候选的行为语义都能对上 Python 的 `openpyxl(data_only=True)`。选择自研路径的唯一理由是**规避受保护文件改动**，而不是库能力不足。若协调者更倾向成熟库，则应把 `read-excel-file@9.3.10`（含 `fflate`、`saxen`、`unzipper-esm`、`worker-f`）连版本一并核定，并接受 `package.json`/`package-lock.json` 的受保护改动。

### 3.3 已实现并验证的读取能力

`dashboard/src/content/calculation/table-reader.mjs`（**可编辑路径**，零 import）：

- 按内容识别 OOXML（`PK\x03\x04`），不依赖扩展名；`.xls` 的 OOXML 正常读取。
- CSV 严格 `UTF-8(fatal)` → `GB18030` 回退；空单元格保留为 `""`，不吞编码错误。
- ZIP 目录解析 + `deflate-raw` 解压；**解压前**按声明大小累计校验 150,000,000 字节上限（对齐 `upload_pipeline.table_rows`）。
- 优先工作表 `功率预测`，否则工作簿首个工作表；支持 `sharedStrings`、`inlineStr`、`1900/1904` 日期系统、日期数字格式判定。
- 公式**只取缓存值 `<v>`**，无缓存即 `null`，绝不自行计算。
- 行按工作表最宽行补 `null`，对齐 openpyxl `sheet.values` 语义，使下游按列名取值不会错位。
- SHA-256 覆盖**原始字节**；实测与 Python `hashlib` 逐字节一致。
- 旧版二进制 XLS / 伪装成 `.xlsx` 的文本：保留现有报错文案。

`dictionaryRows()` 同步复现 `upload_pipeline.dictionaries` 的表头去空格、缺列合并报错、非空重名列报错、整行空白跳过且保留表内行号。

---

## 4. 实测结果

### 4.1 Node 断言（`tests/browser/spike.test.mjs`）

```text
node --test tests/browser/spike.test.mjs
→ tests 26 / pass 26 / fail 0
```

覆盖：空单元格不串列、引号与内嵌逗号、BOM 清理、GB18030 回退、损坏编码拒绝、内容识别 OOXML、优先表选择、共享字符串、缓存公式采用、无缓存公式留空、空单元格为 `null`、1900 与 1904 日期系统（同序列号恰差 1462 天）、缺 `功率预测` 时回退首表、旧版二进制拒绝、空文件拒绝、**解压上限在解压前生效**、原始字节哈希与 `hashlib` 一致、表头规则、31 天读取基线（3.4 MB…见下）。

哈希交叉校验（Python 与 Node 输出完全相同，择要）：

```text
8d5d3c79ae8dc57073151fd61bdd361569b2f49383c02e12b83052da3793b40f   3018  forecast-ooxml.xls
b15169f550dc7c85a7c036ea6a51ab297c64ebdd887cdc2a2cfaab3ad7f3592b    193  minute-power.csv
```

### 4.2 真实浏览器（`tests/browser/browser-spike/`）

仓库父目录起静态服务，使全部资源落在 `/wind-curtailment-analysis/` 子路径下（与 Pages 路径同形），并用 `--host-resolver-rules=MAP * 127.0.0.1:<port>` 把全部主机名解析到本机，使任何外联尝试都会出现在服务端请求日志里。

```text
node tests/browser/browser-spike/run.mjs
→ checks 18/18 passed, result PASS
  报告：reports/browser-review/T0/browser-spike.json（被 .gitignore 忽略，仅本机保留）
```

| 观测项 | 实测值 |
|---|---|
| 子路径下 ESM 依赖加载 | `…/dashboard/src/content/calculation/table-reader.mjs` 200 ✅ |
| 子路径下 module Worker 加载 | `…/browser-spike/spike-worker.mjs` 200，`ok:true` ✅ |
| 31 天输入体量 | 3,437,318 字节 / 44,641 行（4,464,000 字节指针级 CSV 文本） |
| 主线程解析 | **115.2 ms** |
| 主线程顺序遍历（阻塞代理） | **7.3 ms** |
| 长任务（`PerformanceObserver('longtask')`） | 支持=是，**条目为空**（无 ≥50 ms 长任务） |
| Worker 解析 / 往返 | 99.6 ms / 129.2 ms；结果与主线程逐值一致 |
| ArrayBuffer 转移后发送端 | `byteLength === 0`（已分离）✅ |
| `terminate()` 取消 | 同步返回 0 ms，400 ms 内无结果/错误投递 ✅ |
| 浏览器端解析正确性 | 缓存公式 `49`、无缓存公式 `null`、日期序列号正确、旧版 XLS 拒绝 ✅ |
| 持久化存储 | localStorage / sessionStorage / indexedDB / caches **全空** ✅ |
| 跨域请求 | **0 条**；携带合成标记的请求 **0 条** ✅ |
| 服务端请求日志 | 仅静态资源 GET 与结果回传 POST，无任何外联 |

**关键判断：31 天解析无长任务，Worker 现在没有测量依据。** 这与规范 §8「先测量再引入 Worker」及 `AGENTS.md`「Do not introduce workers preemptively」一致。已测范围只包含读取与顺序遍历代理，**不含任何限电规则**；T3 的真实状态机与 366 天边界必须在 T4 重新测量后再决定是否启用 Worker。设计上应保持「算法与调度分离」，使 Worker 可在不触碰算法的前提下加入。

---

## 5. 动态数据接入：G0 的核心缺口

### 5.1 现状链路（读源码得出）

```text
DataAppRuntime.useState(snapshot)
  ├─ hosted=true 且 defer 时：createQueryDataStore(...).onChange → setSnapshot(queries)
  └─ hosted=false（GitHub Pages / 静态包）：
       snapshot = reviewedSnapshot（模块导入，冻结）
       queryDataStore = null
  ↓
DataAppShell({snapshot, onSnapshotChange, queryDataStore})
  └─ shellContext = { snapshot: scopedSnapshot, queries, queryDataStore, setFilter, ... }
       ↑ 内容层只能通过 useDataApp() 读到这里的东西
  ↓
DashboardContent：snapshot.queries.wind_minutes.rows（2,880 行）+ snapshot.wind{meta,summary,daily,gaps}
```

### 5.2 逐条排除的候选通道

| 候选 | 结论 | 依据 |
|---|---|---|
| `queryDataStore.replace(queryId, rows, executedAt)` | 仅 `hosted && deferred` 时存在；**静态包下 `queryDataStore === null`**。且只替换某个 query 的 `rows`，不触 `snapshot.wind`。 | `DataAppRuntime.jsx:31-58`、`query-data-store.js:116` |
| `onSnapshotChange` | 只被受保护代码内部使用（MCP 工具 `update_data_app_query`）；**不在 `shellContext` 中**，内容层拿不到。 | `DataAppShell.jsx:276-285,1046`、`use-data-app.js:257` |
| 直接改 `snapshot` | `snapshot` 由 `DataAppRuntime` 的 `useState` 持有，内容层只收到只读副本。 | `DataAppRuntime.jsx:76-85` |
| `useDataApp()` 返回值 | 仅 `{queries, filters, setFilter, replaceFilters, reviewedRows, reviewedPeriodRows, reviewedAggregatePeriodRows, activeFilters}`，**无任何写入行/快照的入口**。 | `use-data-app.js:319-322` |
| `QueryDataBoundary` | 是懒加载通道，且「Local previews and ordinary publications remain eager」，静态包下直接透传；不提供替换能力。 | `docs/components/async-data.md:49-53` |
| `DataComponent` 的 `sourceRows` / `displayRows` | **可覆盖行**，因此图表、指标、表格、CSV 能由内容层驱动。 | `DataComponent.jsx:113,165`；`DataAppShell.jsx:157-164` |
| 来源面板元数据 | `SourceSidebar` 的 `query` 来自受保护的 `queries[queryId].source`（文件名单、周期、caveats、metricDefinitions），`sourceRows` 只覆盖行，**元数据无法由内容覆盖**。 | `DataAppShell.jsx:144-165`；`source-provenance.js:537,568,598` |
| 应用标题 | `setAppTitle` 在 `shellContext` 中，**内容层可改**。 | `DataAppShell.jsx:1061` |

### 5.3 结论

在静态包上：

- 曲线 / 阴影 / 指标卡 / 分钟明细 / CSV 导出 —— **可以由内容层自持状态驱动并保持一致**（通过 `sourceRows`/`displayRows`）。
- `summary` / `daily` / `gaps` / `meta` —— 内容层可自持，但**无法回写 `snapshot.wind`**。
- 标题 —— 可改。
- **来源查看（文件名单、周期、哈希相关描述）与「导出」的来源口径 —— 无法与用户数据一致**，会继续显示合成演示的来源。
- 更隐蔽的一点：即使补上一个"提交快照"入口，`useDataApp` 的 `const [localQueries] = useState(snapshot.queries)` 在 `queryDataStore` 为空时也**不会跟随新的 `snapshot` prop 重新初始化**，因此 `queries` 仍会停留在旧值。

因此符合规范 §7「若未能建立合法动态快照接入，就视为 G0 未通过」的情形。**不建议以「只做内容层自持 + 保留演示来源」的方式通过 G0**，那正是规范要求拒绝的半成品。

### 5.4 建议提交协调者核定的受保护改动清单（尚未执行）

按 `AGENTS.md` 的范围授权流程，逐路径授权、用 `--source` 构建、由维护者重签清单：

| # | 受保护路径 | 必要原因 | 改动性质 |
|---|---|---|---|
| 1 | `dashboard/src/DataAppShell.jsx` | 把运行时**已有的**快照状态提交能力暴露给内容层（如 `commitSnapshot(updater)` 进入 `shellContext`）。`DataAppRuntime` 已经把 `setSnapshot` 作为 `onSnapshotChange` 传给 shell，此处只是让内容层也能合法调用同一通道，不新建 Provider、不覆盖 DOM。 | 新增一个条目 + 类型注释；不改现有分支 |
| 2 | `dashboard/src/use-data-app.js` | 无 `queryDataStore` 时让 `queries` 跟随 `snapshot` prop（`queryDataStore ? store.getQueries() : (snapshot.queries ?? localQueries)`），否则换入的新快照不会传播到 `queries`，来源/图表/导出会读到旧行。 | 单行语义修正 |
| 3 | `dashboard/protected-runtime.json` | 上述文件改动后必须由维护者重签完整性清单。**不得手工编辑**，须 `DATA_APP_MAINTAINER=1 … verify-protected-runtime.mjs --update --maintainer` 重新生成。 | 生成物 |

配套要求（不新增受保护文件）：`dashboard/package.json`、`dashboard/package-lock.json`、`vite.config.js`、`index.html`、`scripts/*` **均不需要改动**——前提是采纳 §3 的零依赖路径。若改为引入 `read-excel-file`，则 `package.json` 与 `package-lock.json` 必须一并加入清单。

预估范围：**2 个源文件 + 1 份清单**，属局部改动而非「较大范围修改受保护运行时」。按规范 §4 的止损条款，我**不建议**因此停止 T1～T3 的准备，但 T5 的界面工作必须在授权完成后再开始。

### 5.5 备选（零受保护改动，但不建议作为 G0 通过方案）

内容层完全自持分析状态，并用 `DataComponent` 的 `showActions={false}` 关闭内置来源菜单、另起作者自研的来源/导出区块。可以让数值自洽，但等于**移除受保护的产品能力**，且演示来源仍存在于快照中，属规范明令避免的「来源不一致」。仅作为协调者否决 §5.4 时的降级说明。

---

## 6. 未运行的检查（须在交接中如实列出）

| 项 | 未运行原因 |
|---|---|
| `data-app.mjs prepare` / `build` / `export-offline` | 本机**未安装** Data 构建插件（全盘未找到 `scripts/data-app.mjs`，也没有 `build-dashboard` 技能目录），因此在**没有安装插件**的环境里，我无法在真正的受保护构建管线里复现 `?worker&inline`、`docs/components` 入口解析与 `--source` 校验。浏览器验证改用等价的静态子路径服务完成。 |
| 合成分析 A→B 的**整壳**可视化演示（曲线/标题/summary/来源/导出同时变化） | 受两点阻断：① 同上无可用的构建插件来重建壳层；② §5.3 — 静态包下不存在可提交整份快照的合法通道，演示也无法通过合法途径生效。已完成的等价材料：读取与 Worker 已实测（§4.2）；A→B 的**数据并入**语义需在 §5.4 授权并实现 `analysis-session` 后才可验收。 |
| 错误 B 不替换成功 A 的**界面**行为 | 属 T5 验收项（规范 §7 生命周期）。T0 只证明了 `terminate()` 不投递迟到结果，未验证壳层回滚。 |
| 366 天边界与真实算法性能 | 属 T4；本轮只测 31 天读取，且明确不含算法。 |
| 完整清单校验 `verify-protected-runtime.mjs` | 因 §2 基线缺陷（`.openai/hosting.json` 未入库）失败；`--authored-only` 通过。 |

---

## 7. 复现命令

```sh
# 0. 一次性：确认真实仓库无本地改动
git -C <repo> status --porcelain          # 期望为空

# 1. 合成夹具（合成数据，无真实文件）
node tests/fixtures/browser/spike/generate.mjs
python tests/fixtures/browser/spike/generate-gb18030.py

# 2. 现有回归（基线，只读）
python -m unittest discover -s tests -p "test_*.py"
node --test tests/dashboard.test.mjs tests/upload-model.test.mjs

# 3. 新增读取断言
node --test tests/browser/spike.test.mjs

# 4. 可编辑边界（受保护文件必须未被改动）
node dashboard/scripts/verify-protected-runtime.mjs --authored-only .

# 5. 真实浏览器验证（子路径 + Worker + 隐私）
node tests/browser/browser-spike/run.mjs
#    报告写入 reports/browser-review/T0/browser-spike.json（被 .gitignore 忽略）

# 6. 解析依赖候选实测（隔离目录，不改动项目）
#    见 §3.2：在隔离 node workspace 安装 read-excel-file@9.3.10 / exceljs@4.4.0 / fflate@0.8.3
```

本机若未配置 PATH，用计划 §2 给出的绝对路径：

```sh
# Python
"C:/Users/HoRizon/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
# Node
"C:/Users/HoRizon/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
```

---

## 8. 风险与遗留

1. **自研 OOXML 读取的边界**：T0 版本已覆盖实测用例，但共享字符串极值、全部日期格式、逐条解压记账、异常 XML 仍属 T2 加固范围。既有 26 条断言应作为 T2 的回归下限，不得削减。
2. **日期单元格的最终表示**：T0 返回 UTC 编码的 `Date`（与机器时区无关，实测正确），但这只是临时约定。`time.mjs` 必须把墙上时间映射到固定 UTC+08:00，且不得依赖 `new Date(中文日期文本)`。**T1 冻结契约时必须显式写明**。
3. **`MAX_TOTAL_INPUT_BYTES`（60 MB）与文件数 1～400**：本轮只导出常量，未在浏览器实测总大小/数量上限。T5 前需补测。
4. **`.openai/hosting.json` 基线缺陷**：见 §2，需协调者决策。
5. **受保护改动一旦获批，必须重跑**：`--authored-only` + `--source` 构建 + 全量回归 + 浏览器验证；不得只改清单求过。

---

## 9. 交接报告

```text
任务编号：T0
起始基线 SHA / 完成 SHA / 分支：26fd0e7ff436f92327063140f5352cd9b6466327 / <本次提交 SHA> / codex/browser-calculation
修改文件及各自目的：
  dashboard/src/content/calculation/table-reader.mjs   零依赖 CSV/OOXML 读取（可编辑路径）
  tests/browser/spike.test.mjs                          26 条读取断言
  tests/fixtures/browser/spike/generate.mjs             合成夹具生成器（纯 Node）
  tests/fixtures/browser/spike/generate-gb18030.py      GB18030 夹具生成器（Node 无法编码该字符集）
  tests/fixtures/browser/spike/*.csv|*.xls|*.xlsx       合成夹具（8 个，含日期/缓存公式/旧版二进制）
  tests/browser/browser-spike/{index.html,spike-page.mjs,spike-worker.mjs,run.mjs}  真实浏览器验证
  planning/browser-runtime-decision.md                  本文
是否涉及受保护文件，准确路径及授权/验证证据：
  未改动任何受保护文件。git status 仅显示上述新增路径。
  node dashboard/scripts/verify-protected-runtime.mjs --authored-only . → 通过。
  完整清单校验因基线缺陷（.openai/hosting.json 未入库）失败，非本轮引入。
输入/输出接口变化（没有则写无）：
  无冻结接口变更。新增内部函数 readTable/parseDelimited/dictionaryRows/excelSerialToDate/isDateFormat；
  readTable 的返回形状为 {name,sha256,bytes,format,sheetName?,date1904?,rows}，属 T0 临时形状，
  待 T1 契约冻结时并入 Result/InputFile 体系。
新增合成用例与运行命令：
  node tests/fixtures/browser/spike/generate.mjs
  node --test tests/browser/spike.test.mjs
  node tests/browser/browser-spike/run.mjs
实际运行结果（数量、通过/失败、退出码、浏览器版本）：
  Python 57 tests OK；既有 Node 8 pass/0 fail；新增 Node 26 pass/0 fail；
  浏览器 18/18 checks passed（HeadlessChrome/154）。
对照差异数与最大数值误差：
  T0 不涉及算法对照（属 T1/T3）。已做的数值一致性检查：Worker 与主线程逐值一致；
  Python hashlib 与浏览器/Node SHA-256 完全相同。
性能/内存/取消测量：
  31 天 3,437,318 字节 / 44,641 行：主线程解析 115.2 ms、顺序遍历 7.3 ms、无 ≥50 ms 长任务；
  Worker 解析 99.6 ms、往返 129.2 ms；terminate() 同步 0 ms 且无迟到投递。
  未测 366 天、冷/热加载、内存指标（属 T4）。
已知问题与未运行检查：见 §6 与 §8。
报告路径（私有内容只能放 reports/browser-review/）：
  planning/browser-runtime-decision.md（可入库）
  reports/browser-review/T0/browser-spike.json（被忽略，仅本机）
需要协调者作出的决定：
  1) 是否核定 §5.4 的受保护改动清单（2 源文件 + 1 清单），并指定授权与重签执行者；
  2) 解析依赖采用「零依赖自研」还是「read-excel-file@9.3.10 + 锁定传递依赖」；
  3) .openai/hosting.json 基线缺陷如何处置；
  4) 是否批准开展 T1（本机已具备 Python/Node 运行时与 openpyxl 3.1.5）。
```
