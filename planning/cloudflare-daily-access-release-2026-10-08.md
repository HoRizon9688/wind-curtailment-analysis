# Cloudflare 每日口令版本发布记录

用户于2026-10-08确认本地验收通过，授权单独推送每日口令分支并更新Cloudflare，明确要求不合并原版本、不更新Sites。

## 分支与发布范围

- 每日口令分支：`codex/daily-access-token`，已单独推送，不创建合并PR。
- 实现提交：`4973a50`；正式取码及线上验收准备提交：`a4276e6c2b5ba3cf0018f5a4b54b6d8e07ab553a`。
- `main`与`codex/browser-calculation`仍为`e737c5a6803e1c8668d24789af969f3942132ce3`。
- GitHub Pages保持公开，页面字节SHA与原发布清单一致。
- Sites未调用部署或环境变量修改接口；原访问策略与站点保持不变。

## Cloudflare 发布

- 目标为原账号下的`wind-curtailment-analysis` Worker，使用`deployment/cloudflare/wrangler.access.jsonc`。
- 旧版本：`b2028d2e-4b6a-45e8-9609-c4a0e66cadd0`，历史保留。
- 新版本：`30e95fbc-4cef-46e3-bfb0-2a85888d6d8e`，标签`daily-access-2026-10-08`，100%流量。
- 入口：[限电量分解](https://wind-curtailment-analysis.wind-curtailment-static-deployment.workers.dev/?view=1&tab=dashboard)。
- 两份独立生产Secrets与代码一次上传为同一个版本，然后将该版本发布。未复用本地验收密钥，没有将密钥或当日口令写入Git。
- 页面和资源全部先经过Worker鉴权；Cookie到北京时间次日00:00到期，原生限流为5次/60秒的边缘区域近似限制。

## 独立核验结果

- 核心和Worker测试：10项通过。
- 本地Cloudflare浏览器复核：12项通过。
- 新上传版本预览：主页与直接样例访问跳转登录页，登录页正常返回。
- 正式Cloudflare真实浏览器：12项通过，含错误提示、Secure/HttpOnly Cookie、四种宽度、主题、退出、直接资源保护，以及真实上传样例计算后完整JSON导出与Python参考逐字段比对。
- 正式HTTP核验：7项通过，含编码URL、篡改Cookie、跨源退出、三份原应用资产SHA及公开GitHub Pages不变。
- 验收只使用已审核的合成样例，未读上传真实场站资料。验收报告不记录口令、密钥或Cookie。
- Git复核确认只更新独立新分支。

## 管理员取码

在项目下的`deployment/cloudflare`目录运行`npm run access:code:cloudflare`。此命令读取本机被Git忽略的`.dev.vars.cloudflare-production`，不会退回验收密钥。应安全备份该文件；不能将其上传Git或提供给访客。登录口令每天自动更新，不需定时部署。

运行方法及本地/Sites候选说明见`deployment/access/README.md`。Sites候选本轮仍未发布。
