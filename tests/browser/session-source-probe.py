"""T5 independent full-shell build. Never read private measurements/snapshot."""
import json,shutil,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from build_pages_demo import create_demo
from upload_pipeline import snapshot_for
project=ROOT/'reports/browser-review/T5-source/dashboard'
project.mkdir(parents=True,exist_ok=True)
# Official rebuilds preserve an existing output's local-thread tag. This is an
# isolated synthetic test copy, so remove only its exact generated HTML before
# a fresh identity-free build; never touch the user's app output.
old_entry=project/'dist/index.html'
if old_entry.exists():
    assert old_entry.resolve().is_relative_to((ROOT/'reports/browser-review/T5-source').resolve())
    old_entry.unlink()
if '--copy-dependencies' in sys.argv and not (project/'node_modules').exists():
    shutil.copytree(ROOT/'dashboard/node_modules',project/'node_modules')
tracked=subprocess.run(['git','-c',f'safe.directory={ROOT.as_posix()}','ls-files','-z','dashboard'],cwd=ROOT,capture_output=True,check=True).stdout.decode().split('\0')
for name in filter(None,tracked):
    relative=Path(name).relative_to('dashboard')
    if relative==Path('src/data.json') or relative.parts[0] in ('dist','node_modules','.git'):continue
    target=project/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/name,target)
# Include new authored T5 files before staging, without replacing the UI.
for source in (ROOT/'dashboard/src/content').rglob('*'):
    if source.is_file():
        target=project/source.relative_to(ROOT/'dashboard');target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
snapshot=snapshot_for(create_demo(),ROOT/'templates/dashboard-snapshot.json')
snapshot.update(id='t5-full-shell-synthetic-probe',pagesDemo=True,title='风电限电量分析 · 合成数据演示',generatedAt='2026-10-05T00:00:00+08:00')
(project/'src/data.json').write_text(json.dumps(snapshot,ensure_ascii=False),encoding='utf-8')
print(json.dumps({'project':str(project),'synthetic':True}))
