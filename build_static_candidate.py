"""T6: isolated, synthetic-only static candidate. Never deploy or write docs/."""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from datetime import datetime, timezone, timedelta
from pathlib import Path
from build_pages_demo import create_demo, create_demo_inputs
from upload_pipeline import snapshot_for

ROOT=Path(__file__).resolve().parent
SITE_FILES={'site/index.html','site/samples/minute-power.csv','site/samples/forecast.csv'}
PACKAGE_FILES=SITE_FILES|{'USAGE.md'}
REQUIRED_DEPS=('react','react-dom','vite','vite-plugin-singlefile','read-excel-file','fflate','saxen')


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def safe_output(root,output):
    expected_base=root.resolve()/'reports/static-candidates'
    base=(root/'reports/static-candidates').resolve()
    if base!=expected_base:
        raise ValueError('候选输出根目录不能由符号链接或Junction重定向')
    output=Path(output).resolve()
    if output==base or not output.is_relative_to(base):
        raise ValueError('候选仅允许写入 reports/static-candidates/ 下的新目录，不能写 docs 或本机 dist')
    if output.exists():
        raise FileExistsError('候选目录已存在；请指定新的 --output，旧包保持不可覆盖')
    return output


def copy_source(root,project,names):
    records={}
    for name in filter(None,names):
        relative=Path(name)
        if relative.is_absolute() or '..' in relative.parts or relative.parts[0]!='dashboard':
            raise ValueError('源码列表含越界路径')
        relative=relative.relative_to('dashboard')
        if not relative.parts or relative==Path('src/data.json') or relative.parts[0] in ('dist','node_modules','.git','.data-app-assets','.data-app-offline'):
            continue
        if relative.parts[0]=='.openai' and relative!=Path('.openai/hosting.json'):
            continue
        source=root/name
        if source.is_symlink() or not source.resolve().is_relative_to((root/'dashboard').resolve()):
            raise ValueError('源码符号链接或路径逃逸')
        data=source.read_bytes()
        target=project/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
        records[relative.as_posix()]=sha256(data)
    return records


def synthetic_snapshot():
    snapshot=snapshot_for(create_demo(),ROOT/'templates/dashboard-snapshot.json')
    # Provenance text is payload, not a categorical color dimension. Preserve
    # this authored query metadata after the unchanged Python snapshot adapter.
    template=json.loads((ROOT/'templates/dashboard-snapshot.json').read_text(encoding='utf-8'))
    snapshot['queries']['wind_minutes']['payloadColumns']=template['queries']['wind_minutes'].get('payloadColumns',[])
    snapshot.update(id='wind-curtailment-static-candidate-v1',pagesDemo=True,calculationMode='browser',standaloneSite=True,
                    title='风电限电量分析 · 合成示例',generatedAt='2026-01-03T00:00:00+08:00',buildStatus='complete')
    source=snapshot['queries']['wind_minutes']['source']
    source['label']='示例风电场（合成数据） · 56 MW · 2026-01-01—2026-01-02'
    source['caveats'].insert(0,'全部为独立公式生成的合成示例；导入自己的两类文件并确认容量后才能用于场站分析。')
    return snapshot


def locked_versions(project,lock,names=REQUIRED_DEPS):
    versions={}
    for name in names:
        expected=lock.get('packages',{}).get(f'node_modules/{name}',{}).get('version')
        path=project/'node_modules'/name/'package.json'
        if not expected or not path.is_file():
            raise ValueError(f'缺少已安装锁定依赖 {name}；先由开发者执行 npm ci，构建器不自动安装')
        actual=json.loads(path.read_text(encoding='utf-8'))['version']
        if actual!=expected:
            raise ValueError(f'{name} 安装版本 {actual} 与锁定版本 {expected} 不一致')
        versions[name]=actual
    return versions


def check_public_html(data,root):
    for tag in re.findall(rb'<meta\b[^>]*>',data,re.I):
        if re.search(rb'\bname\s*=\s*[\"\']data-app-local-(?:thread|reference)[\"\']',tag,re.I):
            raise ValueError('本机会话或路径 meta 不能进入候选')
    for value in (str(root),root.as_posix(),'CN_37_N0002_W0001_PRED001','莱西'):
        if value.encode('utf-8') in data:
            raise ValueError('候选含本机路径或已知私有场站标识')


def write_package(output,html,samples,snapshot_sha,metadata):
    if set(samples)!={'minute-power.csv','forecast.csv'}:
        raise ValueError('仅允许两个指定合成 CSV 示例')
    if output.exists():
        raise FileExistsError('候选目录不能覆盖')
    if not re.search(rb'<meta\b[^>]*name="data-app-snapshot-sha256"[^>]*content="'+snapshot_sha.encode()+rb'"',html):
        raise ValueError('构建 HTML 与合成快照 SHA 不匹配')
    output.mkdir(parents=True)
    (output/'site/samples').mkdir(parents=True)
    (output/'site/index.html').write_bytes(html)
    for name,data in samples.items():
        (output/'site/samples'/name).write_bytes(data)
    (output/'USAGE.md').write_text('# 静态候选使用说明\n\n此包仅含程序和合成示例，尚未发布。网站文件位于 site/；不要将整个仓库、构建工作目录或真实数据上传。\n\n本机在 site 目录运行 `python -m http.server 4190 --bind 127.0.0.1`，打开 http://127.0.0.1:4190/?view=1&tab=dashboard 。Python只提供静态文件，可换用其他localhost静态服务器，正式托管使用HTTPS以支持Web Crypto；计算不调用Python API。\n\n选择 site/samples/minute-power.csv 和 forecast.csv，填装机56 MW、日期2026-01-01到2026-01-02，勾选容量/同场站确认后计算。实际场站须使用自己的同格式文件和真实容量。浏览器选择文件不会上传；结果仅在当前标签页保留，刷新后需重新导入，请主动下载留档。\n\n支持XLSX、OOXML XLS、UTF-8/GB18030 CSV；分钟表首行保留标准列名，UTC+08、MW。每类最多400文件、总计60MB、连续1—366天；低内存设备优先按较短日期分批。完整JSON含校核字段，网页不另显示校核面板。\n\n候选本机通过验收不等于已获上线批准。后续可将 site/ 内容交给 Cloudflare 静态托管；无需部署 Python、计算 Functions 或数据库。具体发布模式、账号及线上验收另行确认，GitHub Pages本轮不更新。\n\ncandidate-manifest.json记录每个交付文件SHA及来源信息；candidate.zip归档与散文件一致。用源仓库 `python build_static_candidate.py --verify <候选目录>` 检查；哈希用于完整性核对，不是签名或业务真实性证明。\n',encoding='utf-8')
    records=[{'path':name,'bytes':(output/name).stat().st_size,'sha256':sha256((output/name).read_bytes())} for name in sorted(PACKAGE_FILES)]
    manifest={**metadata,'format':'wind-static-candidate-v1','synthetic':True,'published':False,'snapshotSha256':snapshot_sha,'files':records}
    (output/'candidate-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf-8')
    with zipfile.ZipFile(output/'candidate.zip','w',compression=zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(PACKAGE_FILES|{'candidate-manifest.json'}):
            entry=zipfile.ZipInfo(name,date_time=(2026,1,1,0,0,0));entry.compress_type=zipfile.ZIP_DEFLATED
            archive.writestr(entry,(output/name).read_bytes())
    return verify_candidate(output)


def verify_candidate(output):
    output=Path(output)
    if output.is_symlink():
        raise ValueError('候选不能为符号链接')
    output=output.resolve()
    try:
        manifest=json.loads((output/'candidate-manifest.json').read_text(encoding='utf-8'))
        records=manifest['files'];names=[r['path'] for r in records]
        if manifest.get('format')!='wind-static-candidate-v1' or manifest.get('synthetic') is not True or manifest.get('published') is not False:
            raise ValueError('候选身份无效')
        if len(names)!=len(PACKAGE_FILES) or set(names)!=PACKAGE_FILES:
            raise ValueError('候选文件必须匹配固定白名单')
        actual={p.relative_to(output).as_posix() for p in output.rglob('*') if p.is_file()}
        if actual!=PACKAGE_FILES|{'candidate-manifest.json','candidate.zip'} or any(p.is_symlink() for p in output.rglob('*')):
            raise ValueError('候选包含额外、缺失或链接文件')
        for record in records:
            path=output/record['path']
            if not path.resolve().is_relative_to(output):raise ValueError('文件路径越界')
            data=path.read_bytes()
            if len(data)!=record['bytes'] or sha256(data)!=record['sha256']:
                raise ValueError('文件SHA或长度不一致：'+record['path'])
        html=(output/'site/index.html').read_bytes()
        check_public_html(html,ROOT)
        if manifest['snapshotSha256'].encode() not in html:raise ValueError('快照SHA不一致')
        with zipfile.ZipFile(output/'candidate.zip') as archive:
            expected=PACKAGE_FILES|{'candidate-manifest.json'}
            if len(archive.namelist())!=len(expected) or set(archive.namelist())!=expected:
                raise ValueError('ZIP包含额外或重复文件')
            for name in expected:
                if archive.read(name)!=(output/name).read_bytes():raise ValueError('ZIP与散文件不一致')
        return {'files':len(records),'archiveSha256':sha256((output/'candidate.zip').read_bytes()),'htmlSha256':sha256(html)}
    except (KeyError,TypeError,json.JSONDecodeError,FileNotFoundError,zipfile.BadZipFile) as exc:
        raise ValueError('候选清单/文件损坏') from exc


def toolchain():
    home=Path.home()
    node=os.environ.get('WIND_NODE') or shutil.which('node')
    if not node:
        path=home/'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
        if path.is_file():node=str(path)
    plugin=os.environ.get('WIND_DATA_APP_SCRIPT')
    if not plugin:
        candidates=list((home/'.codex/plugins/cache/openai-curated-remote/data-analytics').glob('*/scripts/data-app.mjs'))
        if candidates:plugin=str(max(candidates,key=lambda p:p.stat().st_mtime))
    if not node or not plugin or not Path(plugin).is_file():
        raise ValueError('缺少Node/Data构建器；配置WIND_NODE和WIND_DATA_APP_SCRIPT，不自动安装或降级')
    return node,Path(plugin)


def build_candidate(output):
    output=safe_output(ROOT,output)
    node,plugin=toolchain()
    lock_bytes=(ROOT/'dashboard/package-lock.json').read_bytes()
    versions=locked_versions(ROOT/'dashboard',json.loads(lock_bytes))
    def git(*args):
        return subprocess.run(['git','-c',f'safe.directory={ROOT.as_posix()}',*args],cwd=ROOT,capture_output=True,check=True).stdout.decode('utf-8').strip()
    names=git('ls-files','-z','dashboard').split('\0')
    scratch=ROOT/'reports/browser-review/T6/build';scratch.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='candidate-',dir=scratch) as work:
        assert Path(work).resolve().is_relative_to(scratch.resolve())
        project=Path(work)/'dashboard'
        source_hashes=copy_source(ROOT,project,names)
        shutil.copytree(ROOT/'dashboard/node_modules',project/'node_modules')
        snapshot=synthetic_snapshot()
        snapshot_bytes=json.dumps(snapshot,ensure_ascii=False,allow_nan=False).encode('utf-8')
        (project/'src/data.json').write_bytes(snapshot_bytes)
        env=dict(os.environ);env.pop('CODEX_SESSION_ID',None);env.pop('CODEX_THREAD_ID',None)
        run=subprocess.run([node,str(plugin),'build','--project-dir',str(project),'--source'],cwd=ROOT,env=env,
                           capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=180,
                           creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        (scratch.parent/'build.log').write_text(run.stdout+'\n'+run.stderr,encoding='utf-8')
        if run.returncode:raise RuntimeError('官方源码构建失败；未尝试降级：'+(run.stderr or run.stdout)[-1600:])
        dist=project/'dist'
        if {p.relative_to(dist).as_posix() for p in dist.rglob('*') if p.is_file()}!={'index.html'}:
            raise ValueError('源码单文件构建产生未知资源；需审核后扩展白名单')
        html=(dist/'index.html').read_bytes();check_public_html(html,ROOT)
        inputs=create_demo_inputs()
        samples={'minute-power.csv':inputs['power'][0][1],'forecast.csv':inputs['forecast'][0][1]}
        metadata={'createdAt':datetime.now(timezone(timedelta(hours=8))).isoformat(),'gitRevision':git('rev-parse','HEAD'),
                  'buildMode':'official-data-source-explicit','nodeVersion':subprocess.check_output([node,'--version'],text=True).strip(),
                  'dataPluginVersion':plugin.parent.parent.name,'dataBuildScriptSha256':sha256(plugin.read_bytes()),
                  'lockSha256':sha256(lock_bytes),'dependencies':versions,'sourceSha256':source_hashes,
                  'builderSha256':sha256(Path(__file__).read_bytes()),'demoGeneratorSha256':sha256((ROOT/'build_pages_demo.py').read_bytes())}
        review=write_package(output,html,samples,sha256(snapshot_bytes),metadata)
    return {'output':str(output),**review,'published':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=ROOT/'reports/static-candidates/T6-2026-10-05')
    parser.add_argument('--verify',type=Path)
    args=parser.parse_args()
    result=verify_candidate(args.verify) if args.verify else build_candidate(args.output if args.output.is_absolute() else ROOT/args.output)
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':main()
