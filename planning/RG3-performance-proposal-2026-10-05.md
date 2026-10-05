# G3 年度性能：已授权并执行的最小受保护修复

用户随后明确回复“执行修复方案”，已按下列两条路径实施；代码提交 `1a8feb40770e873ee31497aa511b29044f49b0e7`。原失败证据保留，授权后复测与最终裁决见 [修复审核报告](RG3-fix-report-2026-10-05.md)。下文保留提出方案时的背景和限制。

本机实际整壳测试，366天 / 527,040分钟合成输入可以正确计算并显示，汇总与重新运行的Python一致。但主线程最长任务仍超过既定1秒目标，因此当前不能给出G3通过。

CPU采样定位至 `charting/chart-theme.js` 的语义颜色元数据生成。来源行说明不应作为颜色分类；已通过正式查询 `payloadColumns` 配置将来源/备注/时刻列列为payload，原值与来源功能保留。该配置只改善已应用它的静态候选，不宣称既有私有快照自动得到更新。配置后的实际最长任务1,612ms，年度计算至显示约12.66秒，Chromium报告已用JS堆约694MB；是本机一次测量，非所有设备保证。

剩余拟改范围仅：

1. `dashboard/src/charting/chart-theme.js` 的 `createSemanticColorMetadataAccumulator().addQuery`；
2. `dashboard/protected-runtime.json` 按官方单路径授权工具重签。

核定并已采用的循环：

```diff
 for (const row of rows) {
-  for (const [field, value] of Object.entries(row)) {
+  for (const field of Object.keys(row)) {
+    const value = row[field];
     // 原有 numeric / payload / string 条件及颜色分配全部保留
```

此处实际输入为纯数据行。Object.keys与Object.entries都按相同次序枚举自有可枚举字符串字段；新循环减少逐字段二元数组分配。不能改成抽样、丢列、冻结旧颜色、截断年度范围或隐藏运行时。对具有自定义getter、副作用或Proxy的非数据对象需额外审查，不能假定所有任意JS对象等价。

授权后验证：先添加语义颜色结果的独立固定用例，覆盖payload、数值/空值、异构列和自有/继承属性；确认结果一致后用官方工具仅重签该路径，重新构建并运行年度整壳响应目标、完整Node/Python、保护校验、真实八月差异、完整界面与静态根/子路径检查。若仍超1秒，记录失败并继续诊断，不放宽验收目标。

授权来源要求：[dashboard/AGENTS.md](../dashboard/AGENTS.md) 的 Protected infrastructure 部分规定未请求的受保护变更须确认。授权凭证是用户在本方案之后明确回复“执行修复方案”，不是文档自身赋予权限。GitHub Pages和Cloudflare均不发布。
