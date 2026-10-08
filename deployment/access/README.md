# 每日访问口令

分支：`codex/daily-access-token`，与无口令的`main`、`codex/browser-calculation`独立维护，不合并。GitHub Pages保持公开，原始`docs`发布文件未变。用户已验收并授权仅更新Cloudflare；Sites暂不更新，保留原访问策略。

## Cloudflare 正式站点取码

```powershell
cd deployment/cloudflare
npm run access:code:cloudflare
```

正式密钥独立保存在本机被Git忽略的`.dev.vars.cloudflare-production`，与本地验收密钥不同。该命令明确读取正式密钥，不会回退使用本地验收值。没有这个文件的电脑不能直接取正式口令；管理员应安全备份该文件，不通过Git、聊天或访客分享密钥。每日六位口令可以按需提供给访客。登录有效至北京时间次日00:00。

正式入口：`https://wind-curtailment-analysis.wind-curtailment-static-deployment.workers.dev/?view=1&tab=dashboard`。退出入口：同一域名的`/auth/logout`。登录仅保护Cloudflare入口，公开GitHub Pages仍按用户要求提供原版本。

## 本机启动与取码

需要Node与已安装的`deployment/cloudflare`锁定依赖。PyCharm打开项目后，在Terminal执行：

```powershell
cd deployment/cloudflare
npm run access:init
npm run access:dev
```

打开`http://127.0.0.1:4191/?view=1&tab=dashboard`。在另一个Terminal取当天口令：

```powershell
cd deployment/cloudflare
npm run access:code
```

`access:init`只首次生成本地密钥；再次执行不会覆盖。密钥文件为被Git忽略的`.dev.vars`，不分享、不提交、不用于正式部署。口令会按北京时间日期自动更新，无需Cron或重新构建。取码命令只在管理员本机运行，不提供公开取码API；正式上线后管理员需要安全保留同一生产口令密钥，独立会话签名密钥不必用于取码。

登录成功后仍是原有浏览器内计算。默认5次登录尝试/分钟；错误格式也计入次数。Cookie包含签名而非密码，使用HttpOnly、Secure、SameSite=Lax及主机限定前缀，到北京时间次日00:00失效。退出入口：`http://127.0.0.1:4191/auth/logout`，点击确认退出。已加载页面仍可进行本地计算，刷新或新请求时需重新验证；当前没有跨日强制关闭页面，以免丢失用户未导出的结果。

## Sites 本机模拟

此构建需要现有项目的本地Sites身份配置：`reports/sites/wind-curtailment-analysis/.openai/hosting.json`。它未提交Git；全新克隆需先恢复原项目配置，不能临时创建新Site替代。

Sites平台身份准入保留，每日口令作为第二层。其manifest明确支持D1/R2，而未明确支持Workers原生限流绑定，所以使用D1独立小表记录登录次数；只存短期HMAC客户端键和计数，不保存文件、口令或计算结果。Cloudflare原生限流是边缘区域内的近似限制，不是全局精确账户锁定。

```powershell
cd deployment/cloudflare
npm run access:sites-build
node node_modules/wrangler/bin/wrangler.js d1 migrations apply ACCESS_RATE_DB --local --config wrangler.sites-local.jsonc
node node_modules/wrangler/bin/wrangler.js dev --local --config wrangler.sites-local.jsonc --ip 127.0.0.1 --port 4192
```

打开`http://127.0.0.1:4192/?view=1&tab=dashboard`，使用同一本地口令。`00000000-0000-0000-0000-000000000000`仅为本地模拟标识，不是线上数据库。**不得用这个配置运行远程迁移或部署。**

Sites构建将经过SHA核对的合成HTML与两份样例嵌入独立Worker，不修改已编译的应用脚本、Data运行时或真实数据。候选在被忽略的`reports/access-sites-preview`，同时生成官方流程使用的逻辑D1绑定与`drizzle` schema-only迁移包。Sites线上接入需在用户批准后通过原项目官方流程转换为Worker、设置生产Secrets、绑定D1并应用迁移；保留owner-only权限，不创建新Site。官方本地打包器已检查该候选；生产环境的数据库绑定与迁移仍须在正式部署时校验。

## 本地校验

```powershell
node --test tests/access/access-core.test.mjs tests/access/access-worker.test.mjs
node --test tests/access/access-http.test.mjs
node tests/access/access-browser.mjs http://127.0.0.1:4191
node tests/access/access-browser.mjs http://127.0.0.1:4192
```

以上从项目根目录运行；HTTP/浏览器检查需要先启动两个本地预览。浏览器测试使用Chrome和Python参考实现，可设置`BROWSER_ORACLE_PYTHON`为本机Python绝对路径。真实文件不用于测试。截图和收据在`reports/browser-review/daily-access`。

## 验收后的部署条件

- Cloudflare使用独立`wrangler.access.jsonc`，必须`run_worker_first:true`，避免静态资产直接返回绕过鉴权；保留原Worker名称。缺少有效的双密钥、限流配置或资产绑定时返回503，不能自动退回公开页面。
- Sites使用原项目、原平台身份验证与官方Worker打包流程；正式发布前确认D1迁移已接通，并设置双密钥。绑定缺失或数据库异常会拒绝登录，不使用实例内计数替代。
- 生产密钥应重新生成，通过平台Secrets工具输入，不能复用本地验收文件或把密钥写入参数、Git、网页和日志。若希望两个站点共享每日口令，只同步口令密钥；会话密钥分别生成。
- 登录响应和受保护文件为private/no-store。登录/退出POST要求同源Origin。登录输入有长度、格式和次数限制，Cookie验签与日期检查在服务端完成。
- 这保护两个线上入口；GitHub Pages与公开源码仍按用户要求可访问，不能承诺工具本身完全私有。GitHub Pages不添加前端密码框。

原静态配置和部署脚本保留供无口令版本使用。每日口令版本必须明确选择`wrangler.access.jsonc`，并将独立生产Secrets与代码一起上传为新版本后发布；不能运行原静态`npm run deploy`覆盖正式鉴权入口。Sites构建候选仍仅本地，不自动部署。
