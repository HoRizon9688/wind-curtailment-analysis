# v0.1.0 基础 JSON 接口（历史算法）

本文仅适用于 curtailment.py 的历史 JSON 接口，不代表当前网页阈值算法。当前入口与公式见 [README](../README.md)。

## 快速运行

在本目录运行（Python 3.10 或以上）：

```powershell
python curtailment.py examples/demo.json --output results-demo
python -m unittest discover -s tests -v
```

输出目录必须不存在，以防覆盖旧结果。再次运行请换一个目录名。

输出包括：

- `report.json`：完整结果、配置、时段元数据、状态分组汇总、日/月汇总。
- `intervals.csv`：逐时段输入功率、划分功率、电量、状态、原因和源行号。
- `daily.csv`、`monthly.csv`：按 UTC+08:00 自然日/月汇总；跨午夜时段按实际时长分摊。

CSV 使用带 BOM 的 UTF-8；空白计算值表示不可计算，不表示零。所有示例均为人为构造数据，不是该项目测量结果。

## 计算公式与边界

令 A=可用功率，F=已采用的预测第二点，G=已生效 AGC，P=实发，正部 `[x]+ = max(x,0)`。功率单位 MW，电量单位 MWh。

总差额：`L = [A-P]+`。

当 `G <= F` 且无已知控制逻辑失效：

```text
预测 = [A-max(F,P)]+
调度 = [min(A,F)-max(G,P)]+
其他 = [min(A,G)-P]+
```

当 `G > F`：预测=0，调度=0，其他分成：

```text
指令以上 = [A-max(G,P)]+
指令以下 = [min(A,G)-P]+
其他 = 指令以上 + 指令以下
```

AGC 手动、退出、响应过渡或其他限额介入时：预测=0，调度=0，其他=L，子项为 `other_control`。其他限额优先于 G>F 的特殊场景，因为此时不能假定 AGC 是有效控制上限。

每个有效时段检查 `预测+调度+其他=L`。先计算功率划分，再乘实际小时数得到电量，最后汇总。禁止先平均四条曲线再分配。`other_above_agc`、`other_below_agc`、`other_control`、`other_deadband` 是 other 的子项，不得再加到总差额中；`raw_dispatch` 是审计用原始值，也不得重复累加。

设置 `comparison_tolerance_mw` 后，若 `0 < F-G <= 容差`，原始调度差额转入 `other_deadband`，仍保持闭合。`G>F` 即使偏差小也保留特殊场景，不静默修改原始功率。容差为 null 时保留原始公式，但不把结果标成规则条件已核验。容差不能随意填写；0 表示明确采用零容差，不等于未知。

这是一种分层内部核算约定，不能单凭差额公式证明调度责任、预测责任或可追回电量。`rule_verified` 仅说明调用方声明的规则前提和元数据齐全，不代表工具独立核实了真实因果或调度日志。

## 输入格式

复制 `templates/aligned-input.json`，填写真实数据。首版接收 UTF-8 JSON；四条曲线须先人工或经过核验的适配器整理为同一生效区间。一个文件仅包含一个场站、同一测点口径。

顶层字段：

| 字段 | 含义 |
|---|---|
| station | 场站说明元数据；不参与公式。应记录容量、测点、功率口径、储能情况和可用功率算法 |
| settings | 下表的三个参数；未知填 null |
| intervals | 非空时段数组，按 `[start,end)` 表示，不可重叠 |
| report_start / report_end | 可选，带时区的报告边界，必须覆盖全部输入；省略则使用首条开始至末条结束 |

| settings 字段 | 类型及用途 |
|---|---|
| available_basis_confirmed | true=已核实可用功率不随外部限额下降；null=未知，结果估算；false=基准不可用，不计算 |
| comparison_tolerance_mw | 非负数或 null；AGC 相对预测的比较容差 |
| baseline_tolerance_mw | 非负数或 null；实发高于可用的异常判断容差；未知时所有 P>A 都标记异常 |

每个时段的字段：

| 字段 | 要求 |
|---|---|
| start / end | 必需。带时区 ISO 8601，例如 `2026-09-01T00:00:00+08:00`；不接受无时区时间 |
| available_mw / forecast_mw / agc_mw / actual_mw | 必需。有限非负数，未知填 null；数字字符串不接受 |
| agc_state | automatic / manual / off / unknown；默认 unknown |
| attribution_state | applicable / transition / other_limit / unknown；默认 unknown |
| alignment_verified | 布尔值；默认 false。仅在确实验证了生效区间及采用版本后设 true |
| forecast_version | 实际采用的预测版本标识；未知可省略，但不计为规则前提齐全 |
| forecast_issued_at / forecast_received_at | 预测发布时间/接收时间，均不得晚于 start；接收不得早于发布 |
| forecast_target_at | 第二点的目标时间。不能自动推断它与 AGC 生效时间的映射，应保留原始目标时刻 |
| agc_effective_at | 指令生效时间，不得晚于 start |

可增加源文件名称、日志编号、测点说明等元数据，原样保留在报告中。`alignment_verified` 是外部核验声明，工具不会仅因设置了 true 就自动完成数据匹配。

**时段代表该区间内的功率值**；若来自 15 分钟平均值，则结果是粗粒度估算。程序对长度不少于 15 分钟的时段保守标记 `coarse_estimate=true`。原始瞬时点不能无限保持，应按实际采样覆盖区间填入 end。指令或状态在区间内变化时必须切分区间。

## 质量标记及汇总解释

| status | 意义 |
|---|---|
| rule_verified | 可用基准已确认、控制自动、规则适用、采用关系已声明验证、来源时间/版本齐全且比较容差已设置 |
| estimated | 数值可计算，但上述证据或参数尚未齐全 |
| pending | G>F，或明确控制逻辑不适用，差额保留待核实 |
| baseline_anomaly | 实发高于可用且超出容差；零差额不抵扣其他时段，排除出有效覆盖时长 |
| invalid | 缺关键功率、非法数值、未来版本、非法状态或已知基准不可用；计算值为空 |

时间缺失、结束不晚于开始、重复/重叠区间及非法全局配置直接终止整批计算，避免给出具有误导性的时长或重复电量。缺少单行功率则保留 invalid 行，继续其他行。

覆盖率 = 有效可计算小时数 / 报告窗口小时数。有效时长包含 estimated 和 pending，但不包含 invalid、baseline_anomaly 或未提供的时间缺口；**数据覆盖率不代表归因可信度**，`by_status` 单独列出各状态电量和时长。默认窗口只能反映首末输入之间的缺失，整月统计应显式填写整月报告边界。

summary 中预测/调度电量包含估算，不能统一称为已确认限电。两类占比以“预测+调度”为分母，不包含其他差额；分母为零则为 null。部分覆盖时累计值仅为已观察到的电量，`energy_is_partial=true`，不外推缺失时段；无有效数据时累计零也不意味着实际没有损失。

日/月汇总对跨午夜时段假设区间功率恒定进行分摊；并不会重建区间内部曲线。
