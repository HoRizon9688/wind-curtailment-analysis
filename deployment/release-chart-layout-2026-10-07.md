# 2026-10-07 图表交互与布局更新

用户确认本地页面后授权同步线上站点。沿用 GitHub Pages 的 main/docs、原有 Cloudflare Worker 和 Sites 项目，不新增服务器或付费资源。Sites 仍只允许本人访问。

## 更新内容

- 移除“线性插值 · 规则估算”标签，日期放到右侧导出按钮前。
- 排除区间默认收起，点击标题展开；筛选、定位和导出保留。
- 删除“计算口径与数据质量”介绍块。
- 功率图默认拖动平移，滚轮围绕鼠标缩放，Shift加拖动保留框选；键盘、滑条和恢复全天保留。
- 同步此前已验证的 Sites 静态模式启动修复，避免仅因 chatgpt.site 域名就错误请求 Data API；Sites 平台访问权限不变。

计算公式、插值和阈值未修改。上传文件仍在浏览器内处理，发布资产仅包含演示页面与两份合成样例。

## 发布候选与检查

已验收候选：`reports/static-candidates/local-chart-layout-2026-10-07`。复用完整编译文件，不修改生成的 HTML。

HTML SHA-256：`cb1eda8ece0d9381ecba6a672513651877fc18d2ac1ba88c1e7badce42929983`。

本地检查：视窗数学4项、原生图表/布局12项、静态上传与导出22项、完整界面25项、小时恢复4项、防抖12分钟案例通过；官方内容边界校验通过。Cloudflare 使用锁定 Wrangler 4.147.0 完成发布预检。

三个站点使用相同 HTML 和样例摘要。部署完成后的版本、源码提交及实际线上校验结果补记在此；日常克隆的公开发布清单见 `docs/site-release.json`。

## 实际发布结果

- 源码提交：`01095118fe947ed99b6a583f9460ff5c686c9b3a`；公开资产提交：`2c2ba979f5e6967bd9bc917a479c9eac476644c0`。普通快进同步 main 与 codex/browser-calculation，没有强制推送。
- [GitHub Pages](https://horizon9688.github.io/wind-curtailment-analysis/?view=1&tab=dashboard)：[部署任务37584181411](https://github.com/HoRizon9688/wind-curtailment-analysis/actions/runs/37584181411)成功。自动构建未触发，确认发布来源仍为main/docs后，通过已有凭据在进程内请求构建。
- [Cloudflare](https://wind-curtailment-analysis.wind-curtailment-static-deployment.workers.dev/?view=1&tab=dashboard)：版本`b2028d2e-4b6a-45e8-9609-c4a0e66cadd0`，部署成功；只需上传变化的HTML，原两份样例沿用。
- [Sites](https://wind-curtailment-analysis.jiatenghuipl.chatgpt.site/?view=1&tab=dashboard)：项目`appgprj_6ac5cfd0b0a08191b7fc8584f2058d57`，源码`05900c77c856143cc2d15b0bcdaba55ffd83c4c2`，部署`appgdep_6ac5ec7b3b7881918cbed48b2d5b8702`成功。保存版本`appgprj_6ac5cfd0b0a08191b7fc8584f2058d57~appgver_6de535ddc8048191b34164e24c935658`。访问策略custom，名单仅owner，外部访客0。

Pages与Cloudflare各通过13项完整线上验收，包括原生CSV/XLSX上传、实际Worker计算、完整导出对照Python、曲线/阴影开关、来源、刷新和小时再次点击恢复。三个站点另各通过10项页面/文件与原生交互检查，覆盖日期位置、删除介绍、折叠区间、滚轮缩放、拖动平移、恢复全天和无运行错误/API请求。

Pages与Cloudflare的HTML和两份样例均与验收候选逐字节一致。Sites平台在响应中插入938字节脚本，完整原始HTML没有被替换或删改，完整应用script/style均逐字节保留，两份样例摘要相同。Sites通过临时服务访问检查加载与交互；访问权限从平台读回确认，不将服务检查冒充访客登录验收。

Sites首次打包误用了未安装的WSL，改用已有Git Bash及`TAR_OPTIONS=--force-local`后成功。Pages首次下载实测约14秒，超过原测试10秒预算；仅为远程验收增加可配置加载等待，设为60秒，所有原断言保留。一次后续TLS连接重置后重试完整流程通过，没有改变网页或计算逻辑。

非秘密本机检查收据保留在被忽略的`reports/sites/layout-*.json`及`reports/browser-review/online-release-2026-10-05/`。无真实场站文件、浏览器上传结果或令牌纳入公开仓库。
