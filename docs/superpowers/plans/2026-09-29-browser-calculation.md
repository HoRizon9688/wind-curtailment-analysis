# Browser Curtailment Calculation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 初始协作安排为其他模型执行、原协调者审核；用户于 2026-10-04 改为由协调者自行执行并校验，当前仅推进已授权阶段。不自动派生或跨会话发送任务。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让现有静态网页在浏览器内读取两类场站表格、按现行规则计算并更新完整分析。

**Architecture:** JavaScript ES Modules 计算核心与 React 展示分离；有状态分类按时间顺序执行。Python 保留为本机功能及独立对照。T0 先验证受保护展示运行时的动态结果接入与表格依赖构建，再冻结接口。

**Tech Stack:** 现有 React 19、CSS/SVG、Data 构建器；新增浏览器 ESM 计算模块、经实测需要的 Web Worker、Node 内置测试与 Python unittest。表格解析依赖版本由 T0 实测后锁定，禁止未经验证追随 latest。

**Spec:** `docs/superpowers/specs/2026-09-29-browser-calculation-design.md`；业务概览见根目录 `浏览器计算改造说明.md`。

## Global Constraints

- 基线提交 `26fd0e7ff436f92327063140f5352cd9b6466327`；不要用早期无阈值公式代替现行 `ThresholdAllocator`。
- 每次只算一个场站，固定 UTC+08:00，MW 输入、逐分钟 MWh 输出。
- 预测版本 +15 分钟为第二点目标；只在连续 15 分钟节点间插值，不外推。
- 调度进入 1% / 退出 0.5%；预测空间进入 2% / 退出 1%；跟随误差不超过 1%；AGC 下限参考为 2%；场站未发阈值 0.5%。
- 跨日延续状态，排除分钟重置；实发负值整分钟排除；不改变比较符号。
- 不发布真实文件或结果，不以修改 Python 基线/扩大容差消除 JS 差异。
- 浏览器计算不请求上传 API；当前分析仅驻留本次页面会话，来源/导出必须与图表一致。
- `dashboard/AGENTS.md` 生效；受保护改动范围先经协调核定，禁止绕过完整性检查。
- 此计划中的新文件、接口和命令是待实施交付目标，不代表目前已经存在。

## 1. 文件与接口分工

新增算法模块放入 `dashboard/src/content/calculation/`：

| 文件 | 单一责任 |
|---|---|
| `contracts.mjs` | 算法版本、字段集合、输入/输出校验 |
| `table-reader.mjs` | 字节识别、CSV/OOXML 单元格解析、原文件哈希 |
| `time.mjs` | 明确 UTC+08 时间解析/格式化，拒绝非分钟时间 |
| `input-model.mjs` | 表头校验、去重、场站检查、预测目标映射 |
| `interpolation.mjs` | 二分匹配与连续节点插值，来源信息 |
| `threshold-allocator.mjs` | 顺序阈值状态、分类和阴影区间 |
| `analyze.mjs` | 日期范围、排除、逐分钟推进与完整结果 |
| `aggregate.mjs` | 整期/日汇总、原因区间与内部闭合校核 |
| `calculation.worker.mjs` | 消息入口与错误转换，不包含第二份公式 |
| `calculation-client.mjs` | 任务 ID、进度、取消、过期响应隔离 |

展示接入新增 `dashboard/src/content/dashboard/analysis-session.jsx`，负责业务会话状态及公共结果提交适配；修改既有 `UploadPanel.jsx`、`DashboardContent.jsx` 和必要导出 helper。不预设可修改受保护壳层；T0 给出确切清单后才允许相关任务。

新增测试放 `tests/browser/`；Python 合成期望生成器为 `tests/generate_browser_fixtures.py`；合成输入及期望放 `tests/fixtures/browser/`。真实对照只写入被忽略的 `reports/browser-review/`。

### 共享接口（T1 冻结；后续变更先通知协调者）

```js
// 文档类型，具体用 JSDoc 表达，不要求迁移整个项目为 TypeScript。
// InputFile = {name:string, bytes:ArrayBuffer}
// Options = {capacity:number, stationName:string, start:string|null, end:string|null}
// Input = {power:InputFile[], forecast:InputFile[], options:Options}
// Result = 原 Python analyze_uploads 的六个顶层字段：
// {meta, summary, daily, gaps, rows, calibration}

parseTime(value) // -> 整数 epoch 毫秒；格式不支持则 throw
formatTime(epochMs) // -> YYYY-MM-DDTHH:mm:00+08:00
readTable(file) // async -> {name, sha256, bytes, rows:Array<Array<unknown>>}
normalizeInputs(powerTables, forecastTables) // -> {power:Map, forecasts:Map, metadata}
alignedForecast(epochMs, forecasts, sortedTargets) // -> 同 Python 的插值对象

class ThresholdAllocator {
  constructor(capacity, scale = 1) {}
  reset() {}
  calculate(a, f, g, p) {} // -> 同 Python 的分钟结果；能量 MWh，区间 MW
}
aggregate(rows) // -> 同 Python summary
gapIntervals(rows) // -> 原因分别合并的半开区间
analyzeNormalized(normalized, options) // -> Result，同步纯计算
analyzeFiles(input, onProgress) // async -> Result，调用以上解析及纯计算

createCalculationClient({onProgress, onResult, onError})
// -> {start(input):string, cancel():void, dispose():void}
// onProgress({requestId,phase,completed,total})
// onResult({requestId,result})
// onError({requestId,error:{code,message,file?,row?,field?}})
```

Worker 请求为 `{type:'calculate',requestId,input}`；回复 type 为 `progress/result/error`，均含相同 requestId。取消由主线程 terminate，不要求同步解析库能处理 cancel 消息。禁止通过计时器伪造百分比；不能给出总数的阶段显示阶段名。

2026-10-05 T4 性能实测后核定内部 `result-part` 扩展，详见 `docs/browser-calculation-contract.md`。大结果分批接收，公开成功回调仍只提交一次完整 Result；不改变算法和进度契约。

接口新增 schemaVersion/algorithmVersion 时放 meta，只允许在对照中忽略已列明的版本字段。Python 原有字段不能丢失。`meta.files` 哈希/字节/名称、空值语义、功率和电量单位均须一致。

## 2. 通用测试与提交约定

从项目根目录执行已有回归：

```powershell
python -m unittest discover -s tests -p "test_*.py"
node --test tests/dashboard.test.mjs tests/upload-model.test.mjs
```

若 PATH 未配置，本机可用 Python：
`C:/Users/HoRizon/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe`；Node：
`C:/Users/HoRizon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`。
PowerShell 用 `& '完整程序路径' 参数`，不能仅把路径写成字符串。

新测试命令在对应任务创建后才可执行。只读记录基线测试输出与版本，不把历史“65 测试通过”当作本轮已复测。每个任务先添加会失败的行为测试，运行确认失败原因，再实现，运行通过，提交只包含本任务的代码和合成测试。禁止 `git add .` 带入私有产物；提交前检查暂存清单。

## T0：验证依赖构建与动态分析接入（4～6 小时，G0）

**文件：** 新建 `tests/browser/spike.test.mjs`、`tests/fixtures/browser/spike/` 合成文件、`planning/browser-runtime-decision.md`；候选业务代码限于 `dashboard/src/content/calculation/` 和 `analysis-session.jsx`。受保护文件先只读。

**输入：** 当前 Git 版本、`dashboard/AGENTS.md`、一组只含合成站名的两分钟表格。
**输出：** 被验证的解析库/版本/许可证/锁定来源、受支持构建命令、资源路径策略、动态提交接口及确切必要修改清单。

- [ ] 记录当前 Git 状态、基线 SHA 和现有回归结果；不覆盖用户未提交修改。
- [ ] 读取当前安装构建器返回的组件文档，查验公开更新能力。用合成分析 A→B 演示曲线、标题、summary、来源查看、CSV/壳层导出同时变化。
- [ ] 验证错误 B 不替换成功 A；未获得真实数据更新接口前，不用伪造 Provider 或修改 DOM 绕过。
- [ ] 对候选解析器验证 UTF-8/GB18030 CSV、真实 OOXML 格式合成 XLS、日期单元格和缓存公式；锁定准确版本和可复现获取方式。
- [ ] 测量 31 天合成文件解析/顺序运算的主线程阻塞，记录启用 Worker 的证据；验证本地静态部署及仓库子路径下 Worker/依赖加载。
- [ ] 验证上传合成“私有标记”不会出现在请求体、遥测、自动保存或浏览器持久存储；合法静态资源请求单列。
- [ ] 写出决策：优先普通构建能否实现；若需源码构建，列保护路径与必要原因、依赖安装/锁定步骤，交协调者核定后再修改。
- [ ] 运行验证并保存真实输出，单独提交；G0 通过后才开展 T1～T5。若失败，交替代方案和新估算，禁止自行更换整套 UI 或静默转云端。

测试最小断言（实际实现提供 `readTable` 后运行，不以示例代替完整测试）：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {readTable} from '../../dashboard/src/content/calculation/table-reader.mjs';
test('CSV preserves empty cells', async () => {
  const bytes = new TextEncoder().encode('时间,可用功率\n2026/8/1 0:00,\n').buffer;
  const table = await readTable({name:'sample.csv', bytes});
  assert.equal(table.rows[1][0], '2026/8/1 0:00');
  assert.ok(table.rows[1][1] === '' || table.rows[1][1] === null);
});
```

执行：`node --test tests/browser/spike.test.mjs`。期望测试通过且前述浏览器验证有操作证据；仅 Node 通过不算 G0。

## T1：固定契约和对照样例（4～6 小时）

**文件：** 新建 `contracts.mjs`、`tests/generate_browser_fixtures.py`、`tests/fixtures/browser/`、`tests/browser/compare.mjs`、`tests/browser/contracts.test.mjs`。
**输入：** G0 决策、未修改的 Python pipeline/allocator。
**输出：** 完整样例清单、字段契约、通用比较器 `compareResults(expected,actual)`，不在测试运行时自动重写期望。

- [x] 生成纯合成输入及 Python 期望，记录源提交和文件 SHA-256；同时保留手工算例防止复制共同错误。
- [x] 设计样例覆盖：正常跟随、调度和预测同时存在、AGC 下限、明显高于预测、实发超过 AGC/预测/可用、阈值等号及附近、跨日、排除后重置。
- [x] 输入样例覆盖：编码、OOXML 假扩展名、日期系统、重复一致/冲突、缺列/重名列、多场站、缺节点、负实发、预测坏端点、首尾节点、366/367 天边界。
- [x] 比较器逐字段输出首个和全部差异的路径/时间/输入，不忽略布尔或 null；故意改一行状态、单位、排除原因，确认比较器会失败。
- [x] 固定容差：分钟数值绝对误差不超过 `1e-9`（单位随字段），汇总电量绝对误差不超过 `1e-6 MWh`；时间、状态、原因、计数、来源哈希精确一致。字段不存在和 null 不等价。若需放宽，必须说明数值误差来源由协调者审核。
- [x] 执行 `python tests/generate_browser_fixtures.py` 与 `node --test tests/browser/contracts.test.mjs`，检查生成文件均是合成数据；提交。

2026-10-04 T1 交付及复审见 `planning/T1-report-2026-10-04.md`。允许开始 T2/T3 核心；T2 必须先使 `node tests/browser/audit-table-oracle.mjs` 零差异（T1 时存在 Excel 日期截断及数字转换差异）。T1 当时 G1 未通过，T4/T5 尚未放行；后续裁决见下条更新。

2026-10-05 T2/T3 已完成并通过 G1；交接材料独立审计、修正项及复现命令见 `planning/T2-T3-report-2026-10-05.md`。允许下一阶段执行 T4，本轮未开始 T4/T5。

G1 对照不是比较 HTML，也不是只比较格式化后 3 位小数。

## T2：读取、时间和插值迁移（6～10 小时，可与 T3 核心并行）

**文件：** `table-reader.mjs`、`time.mjs`、`input-model.mjs`、`interpolation.mjs`；测试 `tests/browser/input.test.mjs`、`tests/browser/interpolation.test.mjs`。
**输入：** InputFile、T1 fixtures 与契约；**输出：** normalized、alignedForecast，不包含分类算法。

- [x] 先编写表头、编码、重复、时区、端点插值失败测试；执行对应 Node 测试确认缺失功能。
- [x] 实现原始字节哈希、OOXML内容检测、解压限额、CSV严格解码；不得硬编码 Windows 路径。
- [x] 实现固定 UTC+08 日期转换，禁止依赖浏览器本地时区；有偏移 ISO 正确换算，秒非零拒绝。日期系统问题不得以统一加一天修补。
- [x] 实现单场站校验、重复一致去重、冲突拒绝、空预测跳过和计数，保留来源文件与行号。
- [x] 将预测版本 +15 分钟映射成目标节点；精确节点优先，非连续左右节点返回 `{f:null}`。
- [x] 使用以下手工算例并与 Python fixtures 全量比对，运行两个测试文件，提交 T2。

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTime} from '../../dashboard/src/content/calculation/time.mjs';
import {alignedForecast} from '../../dashboard/src/content/calculation/interpolation.mjs';
test('one minute interpolation and no bridging', () => {
  const t = parseTime('2026-08-01T00:00:00+08:00');
  const nodes = new Map([[t,{value:80,version:'v0',source:'s0'}],
    [t+900000,{value:95,version:'v1',source:'s1'}]]);
  assert.equal(alignedForecast(t+60000,nodes,[...nodes.keys()]).f,81);
  const missing = new Map([[t,nodes.get(t)],[t+1800000,nodes.get(t+900000)]]);
  assert.equal(alignedForecast(t+60000,missing,[...missing.keys()]).f,null);
});
```

执行：`node --test tests/browser/input.test.mjs tests/browser/interpolation.test.mjs`。另用不同浏览器时区运行时间样例，结果必须相同。

## T3：状态分类、排除与汇总（6～10 小时，G1）

**文件：** `threshold-allocator.mjs`、`aggregate.mjs`、`analyze.mjs`；测试 `tests/browser/allocation.test.mjs`、`tests/browser/pipeline.test.mjs`。
**输入：** normalized/Options；**输出：** Result，完整兼容 Python 结果语义。

- [x] 先移植现有 `tests/test_threshold_allocation.py` 全部行为，尤其滞回序列，运行确认失败。
- [x] 逐行映射 allocator：保持状态推进顺序、`>`/`<=`、2%下限参考和 P 修正；能量只除以 60 一次。
- [x] 生成每日完整分钟网格；复现开始/结束推定、坏节点/功率排除、负实发策略，排除时 reset，跨日不 reset。
- [x] 实现 per-reason 半开缺失区间及唯一排除计数，整期/日统计和 calibration，保持状态值和 null。
- [x] 对合成序列/固定种子随机输入检验非负、两条闭合式和按分类阴影高度积分；阈值附近序列不能通过随机测试替代。
- [x] 跑 T1 全量对照，报告最大误差与差异行数；重复同输入结果一致（允许显式生成时间变化）。交 G1 审核后提交/整合。

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {ThresholdAllocator} from '../../dashboard/src/content/calculation/threshold-allocator.mjs';
test('dispatch hysteresis equality exits', () => {
  const m=new ThresholdAllocator(100);
  const states=[79.2,78.9,79.2,79.49,79.5,79.2]
    .map(g=>m.calculate(100,80,g,70).dispatchState);
  assert.deepEqual(states,[false,true,true,true,false,false]);
});
test('already generated power is not counted again', () => {
  const r=new ThresholdAllocator(100).calculate(100,80,60,90);
  assert.equal(r.dispatch,0);
  assert.ok(Math.abs(r.prediction-10/60)<1e-9);
  assert.ok(Math.abs(r.referenceTotal-r.prediction-r.releasedAboveAgc)<1e-9);
});
```

执行：`node --test tests/browser/allocation.test.mjs tests/browser/pipeline.test.mjs`。算法发现原 Python 疑似问题时单列缺陷，不在迁移任务悄悄修公式。

## T4：任务与性能（4～6 小时）

**文件：** `calculation.worker.mjs`、`calculation-client.mjs`、`tests/browser/client.test.mjs`、`tests/browser/worker.test.mjs`。
**输入：** Input；**输出：** requestId 标记的 progress/result/error。

- [x] 先测试旧任务 A 晚于新任务 B 返回，A 不能覆盖 B；取消后的 result/error 都不能写入页面。
- [x] 实现依赖 T0 构建结论的 Worker 入口，所有计算调用同一 `analyzeFiles`；禁止 Worker 与主线程维护两份公式。
- [x] 取消通过 terminate 完成，释放引用；再次计算新建可用实例；卸载 dispose。转移 ArrayBuffer 后如需重试重新读取 File，不复用被转移而清空的缓冲。
- [x] 分阶段汇报读取/校验/计算/汇总，错误统一为契约对象；哈希完成后才能宣告完整成功。
- [x] 记录 15/31/366 天性能、冷/热加载、取消响应及可测内存。处理失败保留用户可重试操作，不把错误回退为 0 电量。
- [x] 运行 `node --test tests/browser/client.test.mjs tests/browser/worker.test.mjs`，并实际加载静态页面 Worker；提交。

2026-10-05 T4 已完成并复审通过，允许继续 T5。性能问题与分批协议扩展、实际 Data 源构建及复现证据见 `planning/T4-report-2026-10-05.md`。完整业务 UI 验收仍属于 T5。

## T5：网页、来源和导出（6～10 小时，G2）

**文件：** `analysis-session.jsx`、已有 `UploadPanel.jsx`、`DashboardContent.jsx`、`wind-model.mjs`、必要内容 CSS；测试 `tests/browser/session.test.mjs`。受保护路径仅使用 G0 核定清单。
**输入：** 完整 Result 和独立表单草稿；**输出：** 当前成功分析、同步来源/导出。

- [x] 先建立 A成功→B计算中→B失败/取消、B成功、两标签页独立的验收场景。
- [x] 文件使用 ArrayBuffer，不再 Base64 POST；浏览器模式不执行 health fetch，不因 Pages 缺少 API 禁用按钮。
- [x] 按 G0 合法适配方式提交完整结果，清理旧查询/展示缓存；日期/范围/分页/回放重置，保留主题与用户明确的显示偏好。
- [x] 新结果待定时不把新站名和旧数值组合；失败恢复原分析，草稿和已计算参数标识清楚；0有效分钟显示无有效结果。
- [x] 明确区分合成示例与用户本地分析；显示格式限制、首尾预测版本要求、UTC+08与容量确认。
- [x] 浏览器导出分钟/日汇总/排除区间/完整 JSON，导出不包含错误的旧站名；复用 CSV 转义和公式文本保护。结果与来源能追溯，校核不增加网页面板。
- [x] 实测四条主曲线和阴影开关、日切换、拖选、明细、来源菜单、各类导出、深浅色、键盘与窄屏。
- [x] 执行 `node --test tests/browser/session.test.mjs` 和现有两个 JS 测试，记录浏览器证据与未能检查项；交 G2。

2026-10-05 T5 已完成、G2 通过。实际官方 Data 源构建、25项完整上传UI验收与完整回归见 `planning/T5-report-2026-10-05.md`。计算方法来源同步仅扩展已核定 `DataAppShell.jsx` 的可选 methods，并由官方脚本重签。T6候选包、真实八月私有对照与发布尚未执行。

## T6：静态交付与说明（4～6 小时，候选包）

**文件：** `build_pages_demo.py` 或经过核定的新构建脚本、`README.md`、必要构建依赖锁文件、`tests/test_pages_demo.py`；公共 `docs/` 仅最终候选的程序/合成示例。
**输入：** G2 通过的代码；**输出：** 可审核静态包、部署命令、构建清单/哈希与回退方式。

- [x] 从独立目录构建，不读取真实 snapshot，不改本机私有结果。记录依赖版本与所需 Node/Data 构建器；不声称访问者需要这些依赖。
- [x] 普通构建优先；必须源码构建时先完成逐路径授权、完整性验证和依赖锁定，禁止自动降级绕过。
- [x] 使用无 Python 计算 API 的静态服务器，验证 `/wind-curtailment-analysis/` 路径中的页面、Worker、解析依赖、示例、刷新均工作。
- [x] README 分清浏览器使用、本机 Python 旧模式、开发构建和发布。注明数据不自动保存、错误/容量/格式限制和已测浏览器。
- [x] 检查公共包与 Git 暂存：无真实原始文件、结果、临时目录、凭据或本机会话元数据；保留示例身份。
- [x] 执行全部已有和新增测试，提供候选包哈希、完整 Git diff、测试日志、性能报告；不自行宣布最终通过或替用户更换托管平台。
- [x] 发布作为独立步骤，待协调者 G3 通过并核对发布授权后执行；保留 `26fd0e7` 静态包/历史作为回退，禁止强制推送回退。

2026-10-05 T6 本机静态候选交付完成，详见 `planning/T6-report-2026-10-05.md`。根据最新用户要求，保持 GitHub Pages/docs 发布包不变，候选与回退包保存于被忽略的 reports/static-candidates；后续拟用 Cloudflare 免费静态方案，未创建项目或发布。候选合成验收通过不替代 R 的真实八月私有回归，也不授予上线权限。

## 3. 协调者独立审核 R（6～10 小时）

审核责任属于原协调者，不是执行模型自己勾选完成。

2026-10-05 已独立执行本机八月六字段/44,640分钟逐值对照、CSV/来源/缺失标记、跨日/排除状态，以及实际静态候选根/子路径和完整界面回归，详见 `planning/RG3-report-2026-10-05.md`。数值和31天功能通过；补测366天整壳发现年度响应超过1秒，已用正式payloadColumns改善但仍未达标。该首次失败记录保留。用户随后授权最小受保护性能修复，代码提交 `1a8feb40770e873ee31497aa511b29044f49b0e7`；新候选年度最长任务836ms，完整回归及真实八月重新对照通过。当前R/G3本机验收通过，详见 `planning/RG3-fix-report-2026-10-05.md`；发布和上线验收按用户要求暂缓。

- [x] **基线确认：** 查看任务分支相对基线的完整差异，确认只有必要文件，记录最终 SHA；确认 Python 公式没有被同步改写来“迎合”新代码。
- [x] **独立重跑：** 本机重新运行旧测试、新测试及干净构建，不只读取执行模型日志。保护校验失败、跳过和浏览器工具不可用都如实记录。
- [x] **合成精确核验：** 审查 T1 人工算例及逐分钟差异报告；重点看等号边界、跨日/排除 reset、单位、重复和时区。确认两条闭合式和面积积分。
- [x] **真实数据私有对照：** 在本机对八月同一输入用基线 Python 和新浏览器算法各算一次。保存输入 SHA、完整参数、最大误差、差异行及原因分布于 `reports/browser-review/`。重新生成基线，不从聊天抄一个总量作为验收标准。
- [x] **特别复查：** 8月1日约04:46附近逐分钟分类；8月5日已知缺失区间是否保持；负实发排除；跨日状态。具体年月和区间从真实文件与基线读取，不硬编码猜测。
- [x] **界面核验：** A/B站切换、取消/失败回滚、来源/CSV/JSON一致、0有效分钟、所有交互、31天与边界范围性能。
- [x] **网络与存储核验：** 用合成唯一标记检查请求/缓存/存储/导出，无用户数据意外外传；在线测试只能使用合成数据，真实数据只在本机浏览器做私有回归。
- [ ] **发布核验：** 静态候选在仓库子路径独立工作，资产与清单一致，不依赖本机 API；上线后验证 URL 与文件哈希，界面检查不以 HTTP 200 代替。
- [x] 给出“通过 / 有条件通过 / 不通过”，列出阻断项、非阻断项、未运行检查及复测结果。公式/状态不一致、数据泄漏、来源陈旧、取消结果覆盖、缺失被补零均是阻断项。

发布核验中本机静态根/子路径及资产清单已验证；在线URL、部署后哈希和托管策略验收尚未运行，因此该项保留未勾选，不代表已发布。全年巨型导出、低内存设备及其他浏览器仍未验收。

## 4. 每包交接报告模板

```text
任务编号：
起始基线 SHA / 完成 SHA / 分支：
修改文件及各自目的：
是否涉及受保护文件，准确路径及授权/验证证据：
输入/输出接口变化（没有则写无）：
新增合成用例与运行命令：
实际运行结果（数量、通过/失败、退出码、浏览器版本）：
对照差异数与最大数值误差：
性能/内存/取消测量（本任务不涉及则说明）：
已知问题与未运行检查：
报告路径（私有内容只能放 reports/browser-review/）：
需要协调者作出的决定：
```

执行模型不承担全局方案随意变更权；解析库、运行时更新范围、结果契约、数值容差、日期上限或业务规则变化，都应在交接中明确，不能通过“优化”之名隐藏。
