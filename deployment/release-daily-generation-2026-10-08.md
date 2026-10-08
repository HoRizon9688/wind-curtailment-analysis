# 2026-10-08 发电量与图表布局同步发布

用户确认本机预览后授权更新GitHub Pages及Cloudflare：Pages保持公开，Cloudflare保留每日口令；Sites不更新。

## 主页范围

- 新增当日/当前范围发电量，按实发正功率每分钟积分；负值厂用电不扣减，缺失和异常不补零，独立显示实发覆盖。
- 五张桌面指标卡同排；逐日图改为“逐日电量分布情况”，展示发电与三类差额，逐日导出同步包含发电量。
- 删除“统一刻度上限”及日期旁联动说明，将日期切换移入功率图工具栏，保留范围联动、缩放和平移。

## 发布方式

复用审核候选`reports/static-candidates/generation-date-reviewed-2026-10-08`，不重新编辑编译HTML。源文件逐项SHA与当前公开源码核对一致；公开源码提交`575f9cc82500bd6e8821da18ed193a253618f8e2`。Pages源码只选择主页提交，没有合并每日口令分支。

HTML SHA-256：`e111eca3cc27f3edb8eba4e2e00264a7ae62f940e0597c01b7ff3170b2666748`。两边复用相同HTML及两份合成CSV；Cloudflare仅在外层增加既有登录网关，不更换生产密钥或令牌到期规则。Pages不包含口令网关。

发布前：发电量与口令核心测试14项、本机发电量/日期/布局12项、图表手势12项、多月份切换7项通过；官方内容边界校验通过。只使用合成数据，不发布真实场站文件或上传分析结果。

## 正式部署与线上核验

- Pages发布资产提交：`a4590baa28fcf3f26a169b657278cca5f88e75c6`；[部署任务37729333258](https://github.com/HoRizon9688/wind-curtailment-analysis/actions/runs/37729333258)成功。公开入口直接加载主页。
- Cloudflare版本：`e421a9d5-ff58-4bb5-9f7a-a63162d45b23`，标签`daily-generation-2026-10-08`，原Worker全量发布。使用`wrangler.access.jsonc`和`--keep-vars`，未上传、替换或输出生产Secrets。
- 正式HTTP7项通过：未登录时直接/编码资源均跳转登录；既有生产密钥仍可登录，Cookie为Secure/HttpOnly；篡改会话和跨源退出被拒绝；正常退出清除Cookie。登录后的三个应用文件及公开Pages逐字节匹配清单。
- Pages新功能浏览器12项、Cloudflare新功能浏览器13项通过，涵盖发电量积分、图表堆叠、日期和范围联动、四种宽度、主题、真实合成文件上传和CSV导出；无浏览器运行错误。
- Cloudflare登录流程浏览器12项通过，包括错误口令反馈、登录、Cookie、退出、直接资源保护；登录后真实上传两份合成样例，完整JSON逐字段对照Python通过。
- 首轮新增线上验收脚本缺少既有`t0-harness`观测标记，导致页面已加载但测试超时；补齐测试URL后原断言全部通过。HTTP检查使用本机既有代理后通过连接检查。两项仅修正验收方式，未修改生产页面、算法或登录逻辑。

验收报告在被忽略的`reports/browser-review/generation-2026-10-08/`与`reports/browser-review/daily-access/cloudflare-production/`，不记录口令、密钥或Cookie。Sites未发布；两份新增真实数据目录未读取、提交或上传。
