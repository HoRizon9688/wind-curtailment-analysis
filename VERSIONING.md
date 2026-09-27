# v0.1.0 初版

本版本将分钟级限电计算、预测时间对齐、线性插值、测试和交互网页纳入统一版本管理。

## 计算口径

- 以可用功率为基准，保留实发、AGC原始分钟值。
- 相邻预测文件第二点以目标时刻为节点，每15分钟区间线性插值至每分钟。
- 不外推、不跨缺失预测版本插值；缺失时段保留未分配差额。
- 区分调度限电、预测限电、其他待核实；逐分钟分类后按1/60小时积分。
- 既有保持法报告与线性插值报告分开保存。分类为分析估算。

## 仓库范围

跟踪Python计算程序、测试、输入模板、网页源码及其运行时文件。真实测量、预测文件、网页数据快照、生成报告、发布归档、个人Sites绑定和本地发布历史不上传。

此前`dashboard/.git`中的发布历史完整移存到本地`reports/git-history/dashboard.git`。项目根目录Git直接管理网页源码，不使用嵌套仓库或子模块。

## 恢复数据并运行

1. 安装Python依赖：`python -m pip install -r requirements.txt`。
2. 将本地测量文件恢复到根目录，将预测文件恢复到`功率预测数据/`。
3. 将`templates/dashboard-snapshot.json`复制到`dashboard/src/data.json`。它只包含页面结构，没有实际数据。若已存在真实快照，无需覆盖。
4. 执行`python refresh_linear_dashboard.py`，生成8月1日线性插值报告及真实网页快照。
5. 执行`python -m unittest discover -s tests`和`node --test tests/dashboard.test.mjs`。网页测试使用生成的真实快照；未恢复数据时不适用。
6. 使用已安装Data插件的`data-app.mjs build --project-dir dashboard --separate-data`构建，遵循`dashboard/AGENTS.md`。构建依赖Data插件，不是独立发布的通用前端包。

## 发布状态

本地功能已验证；Sites服务已部署，但本机上传数据受到Cloudflare HTTP403阻断，在线就绪校验未通过。本版本不宣称线上可用。发布副本和恢复记录保留在本地。

## 版本约定

主分支为`main`，初版标记`v0.1.0`。后续修改使用新提交保留历史，不覆盖初版标签。
