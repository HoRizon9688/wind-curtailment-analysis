# 风电场限电量分析 · v0.2.0

本机网页支持上传一分钟功率表和“数据下载”超短期预测表，完成校验、插值、限电分解和图表展示。支持不同场站分批导入及连续多日期分析。结果为内部规则估算，不等同于调度责任或结算认定。

## GitHub Pages 在线演示

[打开静态演示](https://horizon9688.github.io/wind-curtailment-analysis/?view=1&tab=dashboard)。在线版使用独立生成的两天合成数据，不包含任何实际场站数据，可操作曲线、阴影、日期和明细导出。GitHub Pages不运行Python，所以在线版不提供文件上传计算；自己的数据请按下文在本机运行。

发布来源设置：仓库 **Settings → Pages → Deploy from a branch → main → /docs**。`docs/.nojekyll`使GitHub直接发布生成文件，无需自定义Actions工作流。

更新演示步骤：

```powershell
python build_pages_demo.py
git add -- docs build_pages_demo.py dashboard/src/content/dashboard
git commit -m "Update Pages demo"
git push origin main
```

构建脚本在独立临时目录中使用公式生成合成数据，只复制经过哈希校验的网页和合成快照到`docs/`，不会读取真实数据或覆盖本机快照。需要本机已安装的Node/Data插件。修改前端源码后应先重新执行此脚本再推送；仅推送源码不会自动重新编译演示页面。

## 功能

- 整期/逐日汇总、小时分布、分钟曲线、分类阴影、图表拖选、回放与导出。
- 曲线和阴影独立显示/隐藏；可用为蓝色实线，预测为玫紫色虚线，适配浅色/深色模式。
- 容量比例阈值、进入/退出滞回、AGC最低指令识别、其他差额四项细分。
- 缺失区间与覆盖率；相同记录去重，冲突版本或多个预测场站混传报错。

## 通过 PyCharm 启动（无需 CMD 文件）

1. 用 PyCharm 的 Open 打开项目根目录，例如 `D:/限电量计算`。
2. 配置 Python 3.10+ 解释器。本机可直接使用已经安装依赖的解释器：

   ```text
   C:/Users/HoRizon/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe
   ```

   也可创建项目虚拟环境，在该解释器终端运行 `python -m pip install -r requirements.txt`。

3. 创建 Python Run Configuration：

   | 配置项 | 值 |
   |---|---|
   | Script path | `D:/限电量计算/serve_app.py` |
   | Parameters | `--open --port 4180` |
   | Working directory | `D:/限电量计算` |
   | Python interpreter | 上一步配置的解释器 |

4. 点击 Run。程序先构建网页，再启动本机服务，并打开 `http://127.0.0.1:4180/?view=1&tab=dashboard`。
5. 在网页选择分钟功率表和预测表，核对容量/日期，点击“校验并计算”。保持 Run 进程运行；停止后上传接口不可用。

PyCharm Terminal 中也可直接执行：

```powershell
python serve_app.py --open --port 4180
```

若4180已被旧服务占用，停止旧服务或改为 `--port 4181`。Python代码修改后重启服务。`--no-build`仅用于已有且未修改的构建，首次启动不要加。无需另起前端开发服务器。

### 构建依赖

除Python/openpyxl外，还需要 **Node.js及Codex Data插件构建器**。当前本机已具备并会自动查找；换电脑并不是只安装requirements.txt即可运行。

若自动查找失败，在PyCharm运行配置的Environment variables中设置：

```text
WIND_NODE=C:/Users/HoRizon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe
WIND_DATA_APP_SCRIPT=C:/Users/HoRizon/.codex/plugins/cache/openai-curated-remote/data-analytics/1.0.11/scripts/data-app.mjs
```

按实际安装路径/插件版本调整。日常不要求`npm install`或`npm run dev`。直接打开静态HTML、旧4173预览或仅启动Vite不能代替上传计算服务。

## 输入与时间对应

两类文件均必需；预测来源只需“数据下载表”，不再需要CDQ原始文件。

| 文件 | 必需列 |
|---|---|
| 分钟功率表 | 时间、可用功率、全站总有功_集电线有功之和、AGC有功设定值；理论功率可选 |
| 数据下载预测表 | 预测id、名称、预测时间、考核点2预测结果 |

支持XLSX、系统导出的OOXML格式XLS及UTF-8/GB18030 CSV。单位MW、UTC+08:00、同一测点口径。可用功率应扣除设备受阻，仍反映未受外部限额约束的能力。其他场站先确认时间对应及AGC下限规则一致；储能行为需另行处理。

“预测时间”是文件版本时刻；第二点目标=版本+15分钟。例如前一天23:45上传00:00版本，第二点目标为00:15。相邻目标节点恰隔15分钟时：

```text
F(t) = F左 + (F右−F左) × (t−t左)/15分钟
```

不外推、不跨缺点插值；精确节点仍可独立使用。完整计算首日00:00需前一天23:45版本，末日最后14分钟需末日23:45版本。每条分钟记录代表`[t,t+1分钟)`；末尾次日00:00不额外计一天。

## 两类限电及阈值判定

C=装机容量，A=可用，F=插值预测第二点，G=实际AGC，P=实发，`[x]+ = max(x,0)`。下面计算功率MW，逐分钟除以60并求和得到MWh，不能先平均再分类。

### 状态条件

| 状态/条件 | 进入或成立 | 保持/退出 | 56 MW示例 |
|---|---|---|---|
| AGC最低指令 | 下限=2%C；跟随基准`F跟随=max(F,2%C)` | 不修改原始F、G | 1.12 MW |
| 调度压低D | `F−G >1%C` | 已进入时，降至`≤0.5%C`才退出 | 进入0.56、退出0.28 MW |
| 预测跟随H | 非D且`abs(G−F跟随)≤1%C` | 每分钟判断，含低预测时的AGC下限跟随 | 容差0.56 MW |
| 预测低估Q | 在D或H成立时，`A−max(F,G)>2%C` | 降至`≤1%C`或离开D/H时退出 | 进入1.12、退出0.56 MW |
| 场站指令以下未发 | `[min(A,G)−P]+ >0.5%C` | 否则记小偏差 | 0.28 MW |

首次计算D/Q未进入；按时间顺序更新，跨日保持，排除分钟重置。进入与退出门槛之间按此前状态判断，减少频繁切换；截取期间单独计算时，起点附近状态可能不同于完整期间。

阈值只决定是否归因，**不从已确认分项再扣减一个阈值**。这是本项目分析参数，不是实测控制器死区；当前在`threshold_allocation.py`定义，网页未提供自由调参入口。

### 分解公式

```text
U = [A−max(G,P)]+       # 指令以上实际未发空间
B = [min(A,G)−P]+       # 指令以下未发差额
L = [A−P]+ = U+B        # 总正差额，不能全部称为限电
```

| 条件 | 调度限电功率Dloss | 预测限电功率Floss |
|---|---|---|
| D成立 | `[min(A,F)−max(G,P)]+` | Q成立时`[A−max(F,G,P)]+`，否则0 |
| H成立 | 0 | Q成立时U，否则0 |
| D/H均不成立 | 0 | 0，指令以上空间保留原因未明 |

调度仍比较**原预测F**，不比较抬高后的跟随基准，避免虚增调度损失。实发P参与边界，防止实际已发出的超AGC电量被重复算作损失。A≤G时，即使预测很低，也不虚增预测限电。

### 其他差额四项

令`R=U−Dloss−Floss`，非负。

| 子项 | 条件和功率 |
|---|---|
| 场站指令以下未发 | B>0.5%C时记B，否则0；可能涉及执行、场内限制或可用估计，不能单凭差额认定故障 |
| 指令以下小偏差 | B≤0.5%C时记B，否则0 |
| 指令以上阈值内差额 | D/H成立时记R，否则0 |
| 指令以上原因未明 | D/H均不成立时记R，否则0，优先检查时间对应、采用版本与特殊控制 |

四项不计入两类限电。逐分钟满足`L=Dloss+Floss+其他差额`；同一分钟可同时有多种差额。

### 指令总量校核（不加入网页）

```text
T = [A−G]+
实际已发出的超AGC部分 = [min(A,P)−G]+
T = Dloss + Floss + 指令以上阈值内差额
    + 指令以上原因未明 + 实际已发出的超AGC部分
```

校核位于本地`result.json`的`calibration`字段。不能为凑齐T而忽略已发电量或强行归因；算术闭合不证明调度原因已独立验证。

## 排除与覆盖率

- 关键功率缺失/非数值、分钟缺行、无法匹配预测、关键功率超容量、可用/AGC/预测负值，整分钟排除；插值端点非法也排除。
- 低风厂用电负实发分钟整分钟排除，不补零、不计其他差额。
- 实发高于可用时保留分钟、正差额计0并标记异常，不负向抵扣。
- 覆盖率=参与分钟/所选日期应有分钟；排除区间按`[起点,终点)`表示，重叠原因只扣一次时长。
- 结果只累计有效分钟，不外推缺失电量。无有效分钟时网页显示“—”，不据此认定零损失。

## 技术栈与流程

| 层 | 技术 |
|---|---|
| 前端 | React 19、JavaScript/JSX、CSS；主要曲线与阴影为自定义SVG，React管理交互与状态 |
| 页面运行时/构建 | Codex Data App提供主题、来源检查和页面容器；当前本机启动用Node调用Data插件的 `--source` 源构建，需要先安装锁定依赖 |
| 后端 | Python标准库`ThreadingHTTPServer`/`SimpleHTTPRequestHandler`，不是Flask/Django；仅监听127.0.0.1 |
| 数据计算 | openpyxl读Excel，csv读CSV；upload_pipeline.py负责校验与插值，threshold_allocation.py负责有状态归因 |
| 通信/存储 | Fetch向`POST /api/calculate`提交JSON+Base64；本地CSV/JSON，无数据库 |
| 测试 | Python unittest、Node内置test runner；合成数据不依赖私人快照 |

流程：选择文件 → 本机接口解码 → 校验、插值与逐分钟归因 → 写快照并构建 → 浏览器刷新。支持一次一个计算任务；属于单用户本机工具，静态Sites托管不能单独运行Python接口。

## 输出与测试

最近结果在`reports/latest/`：result.json、minutes.csv、daily.csv、excluded-intervals.csv。网页快照为`dashboard/src/data.json`，构建产物为`dashboard/dist/`。再次成功计算替换最近结果，需要留档时先导出或复制。

```powershell
python -m unittest discover -s tests
node --test tests/dashboard.test.mjs tests/upload-model.test.mjs
```

原始数据、案例材料、真实快照、报告、凭据和IDE配置不上传Git。首次克隆缺少快照时，服务从空模板初始化上传页面。

更多说明：[本机操作](本机使用说明.md)、[阈值归因](阈值归因说明.md)、[版本记录](VERSIONING.md)。保留的`curtailment.py`为v0.1.0基础JSON历史算法，见[历史核心说明](docs/legacy-core.md)，不要与当前网页算法混用。

## 浏览器计算迁移进度

`codex/browser-calculation` 分支已完成 T0-R2、T1、T2、T3 和 T4，G1 计算对照通过。已实现浏览器文件读取、时间匹配、预测分钟插值、阈值状态分类、完整结果汇总，以及 Worker 进度、取消、旧任务隔离与大结果分批传回。详见 [T1 契约](docs/browser-calculation-contract.md)、[T2/T3 审核](planning/T2-T3-report-2026-10-05.md) 和 [T4 验收及性能](planning/T4-report-2026-10-05.md)。

T1 发现的 Excel 日期截断及数字字符串差异已修复；Python 公式、冻结样例和容差保持不变。浏览器核心已通过 Chrome 四时区和完整 Worker 结果核验；15/31/366 天性能及取消已实测。尚未接入上传页面，本机网页仍通过 Python 计算；下一步是 T5 页面上传、结果更新、来源及导出接入。当前网页启动方式保持不变。
