# 开发构建与部署

访问在线站点或运行已构建的docs页面，不需要这些开发工具。下面用于修改源码后生成新的发布版本。

## 构建

需要Python3.10+、支持Vite8的Node、已安装的Codex Data插件，以及dashboard的锁定依赖。当前构建使用Node24、Data1.0.11；不要自动升级运行时或绕过受保护文件校验。

在项目根目录运行：

```powershell
python -m pip install -r requirements.txt
cd dashboard
npm ci
cd ..
python build_static_candidate.py --output reports/static-candidates/new-release
python build_static_candidate.py --verify reports/static-candidates/new-release
```

输出目录必须是reports/static-candidates下的新目录，不能覆盖已有候选。构建器只使用独立生成的合成示例，不读取真实分钟表、预测目录或私有快照。Data插件找不到时设置本机真实路径 `WIND_DATA_APP_SCRIPT`，Node找不到时设置 `WIND_NODE`。

## GitHub Pages

发布来源为main分支的/docs目录。将审核通过的候选site/index.html与site/samples中的两份CSV复制到docs对应位置，更新docs/site-release.json中的来源提交和文件SHA；保留docs/.nojekyll。不要运行旧build_pages_demo.py覆盖新版页面，也不要复制私有快照或整个仓库。

提交并正常推送main后，等待Pages部署成功，再检查在线HTML与合成样例SHA及实际上传计算。仅HTTP200不能代表页面已更新。旧版本可从Git历史恢复，禁止强制推送回退。

## Cloudflare

使用Workers Static Assets托管同一候选的site目录，不部署Python计算服务、数据库或文件上传接口。静态资产请求免费且不另收资产存储费，规则以[官方计费说明](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)为准。

独立的cloudflare目录锁定Wrangler4.147.0，不更改dashboard依赖。先确认wrangler.jsonc中assets.directory指向本次审核通过的候选site目录；当前配置指向release-2026-10-07。新克隆尚无该候选，需要先以相同输出目录构建，或构建新的候选后更新目录。

```powershell
cd deployment/cloudflare
npm ci
npm run login
npm run whoami
npm run check
npm run deploy
```

在官方浏览器页面完成登录。若有多个账号，先明确目标账号并按Wrangler文档配置，不把令牌、密码或OAuth配置提交到Git。部署仅上传候选site中的三个公开文件，不上传审核ZIP、reports、真实数据或本机结果。

更新后核对返回的workers.dev地址、部署版本和线上文件SHA，并用合成文件验证上传、导出、来源、刷新、曲线和阴影。真实数据只在本机回归；全年巨型导出和低内存设备暂不纳入验收。
