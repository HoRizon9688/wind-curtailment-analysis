# T6 静态候选：本机查看、构建和后续上线

本文保留T6候选构建流程。用户于2026-10-05随后授权更新README、GitHub Pages并上线Cloudflare，当前发布资产为standalone-2026-10-05-final，公开运行方式和部署命令以 [README](../README.md) 与 [部署说明](../deployment/README.md) 为准。浏览器计算已覆盖完整上传/校验/插值/分类/图表/导出；Python旧模式仍保留用于本机CLI与独立对照。

## 查看候选，无需计算后端

原T6候选路径及SHA见 `planning/T6-report-2026-10-05.md`。当前候选见 `planning/RG3-fix-report-2026-10-05.md`：小时柱形再次点击恢复全天；真实八月数值、完整界面及年度响应目标通过，R/G3本机验收通过；线上发布已另获用户授权，具体上线检查以本次发布记录为准。旧失败记录保留。候选在被Git忽略的 `reports/static-candidates/`。审核ZIP含site、使用说明及清单，**不是直接部署的根目录ZIP**；部署时只选 `site/` 目录内容。

以报告中的候选目录为例，在项目终端运行：

```powershell
python -m http.server 4190 --bind 127.0.0.1 --directory reports/static-candidates/standalone-2026-10-05-final/site
```

打开 `http://127.0.0.1:4190/?view=1&tab=dashboard`。这个Python进程只提供静态文件，既无health/calculate API，也不接收所选文件；可用其他静态服务器在localhost提供，正式托管使用HTTPS；SHA-256与任务ID依赖安全上下文中的Web Crypto。最终在线访问者只需支持相关浏览器API的浏览器，不需要Python、Node、Codex或Data插件。不要拿过期4173页面作为新版本验收对象。

验证上传可选择候选的 `site/samples/minute-power.csv` 与 `forecast.csv`，装机56MW、日期2026-01-01到2026-01-02，勾选同场站/容量确认。这些仅为合成演示，实际计算必须选择该场站自己的两类文件，确认真实容量与测点口径。

文件在当前标签页通过File.arrayBuffer交给Web Worker处理，成功后一次性更新分析。失败/取消保留原分析；刷新、关闭或另开标签页从初始示例开始，需要重新导入。结果不会自动写磁盘，请主动导出整期分钟、逐日汇总、排除区间或完整JSON（含calibration）；当前日图表范围也可下载。主题等展示偏好可由壳层保留，用户文件和计算结果不自动保存。

支持标准首行列名的CSV（UTF-8/BOM/GB18030）、XLSX、实际OOXML格式的XLS；旧二进制XLS应另存XLSX。UTC+08、MW、一分钟功率数据；预测第二点按版本+15分钟映射并线性插值，缺失不补零。每类400文件、总计60,000,000字节、工作簿解压150MB、1—366天。366天实际整壳计算/汇总/末日曲线及1秒主线程目标已在本机Chrome154验证；巨型整期JSON/CSV导出及低内存设备按用户要求暂不纳入验收，可按较短日期分批使用。没有降低366天上限或放宽目标。时间与内存测量见修复报告，不保证所有设备同等速度。

分钟功率与预测表列名见README及本机说明；分钟表本身不能自动证明站点身份，必须由上传者确认同场站。其他场站的AGC控制规则也需符合当前规则，不能把数值归因当作调度责任独立证据。

## 开发者构建候选

现有普通预编译构建不能代替本分支已核定的壳层适配与表格包源码构建。候选命令显式调用官方Data `--source`，不自动降级、不安装依赖、不重签保护文件，也不执行旧 `build_pages_demo.py` 发布主流程。

构建需要Git、Python3.10+/openpyxl、兼容Vite8的Node、已安装Codex Data插件与dashboard锁定依赖。当前实测Data1.0.11、构建Node24.21.0；Node测试用Codex24.19。已安装关键包必须符合package-lock版本，完整锁文件SHA及实际版本写入候选清单。

新电脑或全新克隆先由开发者安装Python依赖并在dashboard运行 `npm ci`；这一步可能联网，候选构建器不会替用户执行安装：

```powershell
python -m pip install -r requirements.txt
cd dashboard
npm ci
cd ..
```

Data插件需另行安装，不能只靠上述两步。若自动定位失败，配置本机真实路径：

```powershell
$env:WIND_NODE='C:\你的Node目录\node.exe'
$env:WIND_DATA_APP_SCRIPT='C:\你的Data插件目录\scripts\data-app.mjs'
python build_static_candidate.py --output reports/static-candidates/T6-new
python build_static_candidate.py --verify reports/static-candidates/T6-new
```

候选输出只允许在 `reports/static-candidates/` 下的新目录，拒绝覆盖、越界或链接重定向；更换名称即可重新构建，旧包保留。临时源码副本只复制Git跟踪程序，跳过私有src/data.json、其他托管身份、dist、node_modules等，再单独复制已安装依赖并注入独立合成快照。构建环境去掉本机会话ID，不继承旧dist身份；失败直接报错。程序不读取原始测量目录，不写本机私有结果或docs发布包。

候选只允许四个交付文件（site/index.html、两份合成CSV和USAGE.md）以及候选清单与审核ZIP；site为单文件程序，解析依赖和Worker已内联。`candidate-manifest.json`记录每个文件大小/SHA、合成快照SHA、Git起点、实际源码/构建器/生成器SHA与锁定依赖。verify核对文件白名单、大小、哈希、快照身份和ZIP/散文件一致；不把哈希等同于数字签名。构建日志位于reports/browser-review/T6。

## Cloudflare部署选择记录

当前采用Workers Static Assets部署，仅上传候选site目录；不启用服务端计算或数据资源。静态请求与资产存储免费，见 [官方计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)。下文为先前Pages方案评估，不是本次实际部署方式。

本项目计算已移到浏览器，静态托管即可提供完整当前分析功能；不用为了上传计算部署Python后端、Functions、数据库或文件存储。后续可选择Cloudflare Pages静态站点方案，先在本机审核通过，再交付预构建的 `site/` 内容。当前HTML约5.69MB，低于官方Pages单资源25MiB上限；全站仅3个站点文件，也低于免费计划20,000文件上限。免费额度与产品入口可能变化，正式上线时再核对账号及官方规则。[Pages限制](https://developers.cloudflare.com/pages/platform/limits/)

Pages支持上传本机预构建资产，适合目前依赖本机Data构建器的流程；但Direct Upload项目不能直接切换为Git集成，若以后需要Git自动部署，应在创建项目前确认路径，不能假设Cloudflare构建环境已有Codex插件。此处仅保留可行方案，不创建项目或登录账号。[Direct Upload文档](https://developers.cloudflare.com/pages/get-started/direct-upload/)

上线前的真实八月私有对照与本机R/G3现已完成；发布时仍需核对目标账号、发布根目录、所用哈希、刷新与Blob Worker行为；线上只用合成数据验收。上传对象仅site，真实数据/结果/整个仓库不得作为托管目录。Pages默认资源加载策略下本地Worker已验证；若另设CSP，应允许内联应用代码和blob Worker，并重新验证。发布是单独授权步骤，网站顶部Data平台的Publish按钮不是本项目Cloudflare发布入口。

## 回退

旧已公开合成演示基线 `26fd0e7ff436f92327063140f5352cd9b6466327` 与Git历史保留。T6还从Git blobs恢复并按原data-app-build.json验证HTML/快照，保存 `reports/static-candidates/rollback-26fd0e7/site/` 及回退ZIP/receipt；详见交付报告。

后续已上线版本若需回退，重新部署经哈希校验的旧site内容或使用托管平台的既有回退入口，再做线上合成验收；不reset硬覆盖工作区、不强制推送历史。旧演示只能展示合成数据，不能冒充浏览器上传功能仍正常。GitHub Pages新版按main/docs发布；若需回退，应恢复经校验的历史公开站点资产并正常提交推送，再复查线上行为。
