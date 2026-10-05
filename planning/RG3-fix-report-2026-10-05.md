# R/G3 性能修复与本机最终审核

**裁决：R/G3本机验收通过。** 原年度响应阻断项已解决，计算与原算法保持一致。GitHub Pages、Cloudflare发布以及部署后的在线验收仍按用户要求暂缓；不将本机通过等同于已经上线。全年巨型导出、低内存设备与其他浏览器未验收。

分支 `codex/browser-calculation`；起始提交 `de321f62a68bf89fc41aba62bf430852a3b6edfc`；修复代码提交 `1a8feb40770e873ee31497aa511b29044f49b0e7`；原Python算法基线 `26fd0e7ff436f92327063140f5352cd9b6466327`。本报告为代码提交之后的交付记录。

## 授权与实际变更

用户针对 `RG3-performance-proposal-2026-10-05.md` 明确回复“执行修复方案”。只修改 `dashboard/src/charting/chart-theme.js` 的颜色扫描循环及官方工具生成的 `dashboard/protected-runtime.json` 单条摘要：`Object.entries(row)` 改为 `Object.keys(row)` 后读取 `row[field]`，减少每个字段临时二元数组的分配。

numeric优先、payload过滤、字段顺序、日期/URL/ALL过滤、分类碰撞处理和调色板保持原样。没有抽样、丢字段、截断日期或放宽1秒目标。该等价性适用于实际JSON纯数据行，不扩大承诺到副作用getter或Proxy。之前的正式payloadColumns配置仍是静态候选性能前提，既有私有快照未被改写。

从dashboard根目录使用 `DATA_APP_USER_CONFIRMED=1` 和官方 `scripts/authorize-protected-change.mjs --confirmed --scope src/charting/chart-theme.js` 重签，原因明确引用已批准方案。完整保护校验234文件通过；未手改摘要、修改校验器或留下通用解锁。

新增4项固定独立颜色用例，覆盖异构列、跨查询分类、同查询碰撞、payload、数值/空值、自有可枚举属性和空原型行。修改前后均通过，作为行为保持验证。最初手工期待误以为碰撞避让跨查询全局共享，核对原源码后修正测试期待，没有为测试改变产品。性能失败复现由原年度整壳测试提供。

## 实测与回归

| 验证 | 本轮结果 |
|---|---|
| Python完整旧/新测试 | 74/74，退出0 |
| Node完整旧/新测试 | 106/106，失败/跳过0，退出0 |
| 受保护文件 | 234文件校验通过 |
| 小时二次点击恢复全天 | 4项通过，最终候选再次实测 |
| 完整界面 | 25项通过；含换站、取消、失败回滚、来源、四条曲线/阴影、导出、主题、390px |
| 静态根/仓库子路径 | 22项通过，CSV与XLSX原生选择→实际inline Worker→完整JSON对照 |
| 真实八月私有对照 | 10项通过；44,640行、六字段完整Result零差异，CSV36列逐值核对 |
| 年度实际整壳 | 527,040分钟/366天，新Python汇总一致；末日/24小时图显示正常 |

真实八月分钟数值最大误差0，汇总最大误差约2.84e-14MWh，固定容差未变。三个Python核心模块LF归一化字节仍与原Git基线一致；未通过改Python迎合浏览器结果。04:46窗口、已知缺失区间、负实发排除、跨日状态、两条闭合式及阴影面积已重算复查。私有输入SHA、数值、原因区间及完整报告只保存于被忽略的 `reports/browser-review/RG3-approved-private-2026-10-05/`，不纳入公共Git或候选。

修复前同一年度测试本轮复现最长任务 **1,406ms**（退出1）；修复后 **836ms**（退出0），通过既定不超过1,000ms目标。修复后计算至显示约 **11.38秒**，末日切换约 **260ms**，Chromium报告已用JS堆约 **695.5MB**。这些是本机测量，不是所有设备的速度或内存保证；内存没有明显下降，不声称内存问题已解决。之前1,612ms及更早失败记录均保留。

浏览器Chrome154.0.8037.93；测试Node24.19，官方Data源码构建Node24.21、Data1.0.11。第一次Python测试虽输出74 OK，但Windows子进程默认GBK产生解码线程异常；配置 `PYTHONUTF8=1` 后完整重跑74项，无异常，最终采用重跑结果。没有修改产品代码来消除测试环境编码问题。

原生文件只交给本机inline Worker；本次所测流程没有计算API、外部应用请求或用户数据持久保存。刷新恢复独立合成示例。私有快照摘要与修改前相同；未覆盖用户已有 `outputs/`。

## 最终候选与启动

候选：`reports/static-candidates/RG3-approved-2026-10-05-final/`。代码提交后重新官方源码构建，完整包verify通过。最终HTML与上述所有浏览器测试所用候选逐字节一致，另在最终路径重跑小时4项和保护校验。正式交付收据在 `reports/browser-review/RG3-fix-2026-10-05/final-receipt.json`。

- HTML SHA-256：`ad17516116aa0ef0de427a40564c162de5f4dcdb3ed577f4f5cc3366563b099a`
- 审核ZIP SHA-256：`9a650e775d56db5b1e8e6e53679a40c73ea45efe4d10a1676688bdafc7ae206f`
- 公共包只有合成示例；原始测量、真实结果和私有托管身份不入包。部署对象将是site目录，不是整个审核ZIP或项目文件夹。

```powershell
python -m http.server 4190 --bind 127.0.0.1 --directory reports/static-candidates/RG3-approved-2026-10-05-final/site
```

打开 `http://127.0.0.1:4190/?view=1&tab=dashboard`；旧4173页面不是此次候选。此进程仅提供静态文件，上传、插值、分类和导出均在浏览器内执行。

## 复现

```powershell
$env:PYTHONUTF8='1'
$env:BROWSER_ORACLE_PYTHON=(Get-Command python).Source
python -m unittest discover -s tests -p "test_*.py"
node --test --test-concurrency=1 tests/dashboard.test.mjs tests/upload-model.test.mjs tests/browser/*.test.mjs
node dashboard/scripts/verify-protected-runtime.mjs dashboard
python build_static_candidate.py --verify reports/static-candidates/RG3-approved-2026-10-05-final
node tests/browser/hour-range.mjs reports/static-candidates/RG3-approved-2026-10-05-final
node tests/browser/session-ui.mjs reports/static-candidates/RG3-approved-2026-10-05-final
python tests/browser/static-candidate-inputs.py reports/static-candidates/RG3-approved-2026-10-05-final
node tests/browser/static-candidate.mjs reports/static-candidates/RG3-approved-2026-10-05-final
# 性能验收单独执行，避免并发测试争抢CPU；仍严格使用1秒目标。
node tests/browser/annual-ui.mjs reports/static-candidates/RG3-approved-2026-10-05-final
```

本机测试及失败/成功证据保存于reports，Git文档不替代原始记录。后续发布需另行核对授权、账号、site哈希、HTTPS/CSP/Blob Worker和部署后合成验收；这些没有在本轮执行。
