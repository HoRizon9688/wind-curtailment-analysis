"""Single-user loopback service for uploads, local calculation and dashboard builds."""
from __future__ import annotations

import argparse
import base64
import binascii
import json
import os
import shutil
import subprocess
import threading
import webbrowser
import zipfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from upload_pipeline import analyze_uploads, snapshot_for, write_outputs

ROOT = Path(__file__).resolve().parent
MAX_REQUEST = 100_000_000
CALCULATION_LOCK = threading.Lock()


def validate_origin(origin, host, port):
    allowed = {f'127.0.0.1:{port}', f'localhost:{port}'}
    return host in allowed and origin in {f'http://{h}' for h in allowed} and origin == f'http://{host}'


def decode_uploads(items):
    if not isinstance(items,list) or not 1 <= len(items) <= 400:
        raise ValueError('每类须上传 1—400 个文件')
    files = []
    for item in items:
        name = item.get('name','')
        if not isinstance(name,str) or not name or any(c in name for c in ('/','\\',':','\x00')):
            raise ValueError('文件名无效')
        try:
            blob = base64.b64decode(item['data'], validate=True)
        except (KeyError, TypeError, ValueError, binascii.Error) as exc:
            raise ValueError(f'{name}：上传内容编码无效') from exc
        if not blob or len(blob) > 60_000_000:
            raise ValueError(f'{name}：文件为空或超过 60 MB')
        files.append((name,blob))
    return files


def build_dashboard():
    home = Path.home()
    node = os.environ.get('WIND_NODE') or shutil.which('node')
    if not node:
        candidate = home/'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
        if candidate.exists():
            node = str(candidate)
    plugin = os.environ.get('WIND_DATA_APP_SCRIPT')
    if not plugin:
        candidates = list((home/'.codex/plugins/cache/openai-curated-remote/data-analytics').glob('*/scripts/data-app.mjs'))
        if candidates:
            plugin = str(max(candidates,key=lambda p:p.stat().st_mtime))
    if not node or not plugin:
        raise RuntimeError('缺少 Node 或 Data 插件构建器。请查看 本机使用说明.md 配置 WIND_NODE / WIND_DATA_APP_SCRIPT。')
    run = subprocess.run([node,plugin,'build','--project-dir',str(ROOT/'dashboard'),'--separate-data'],
                         cwd=ROOT,capture_output=True,timeout=180,encoding='utf-8',errors='replace',
                         creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    if run.returncode:
        raise RuntimeError('图表构建失败：'+(run.stderr or run.stdout)[-1800:])


def calculate_and_build(payload):
    result = analyze_uploads(decode_uploads(payload.get('power')),decode_uploads(payload.get('forecast')),
                             start=payload.get('start') or None,end=payload.get('end') or None,
                             capacity=payload.get('capacity'),station_name=str(payload.get('station') or ''))
    path = ROOT/'dashboard/src/data.json'
    previous = path.read_bytes() if path.exists() else None
    path.write_text(json.dumps(snapshot_for(result,ROOT/'templates/dashboard-snapshot.json'),ensure_ascii=False,allow_nan=False),encoding='utf-8')
    try:
        build_dashboard()
    except Exception:
        if previous is not None:
            path.write_bytes(previous)
        raise
    write_outputs(result,ROOT/'reports/latest')
    return {'summary':result['summary'],'meta':result['meta']}


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        super().end_headers()

    def respond(self, status, value):
        blob = json.dumps(value,ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def do_GET(self):
        if self.headers.get('Host') not in {f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'}:
            return self.respond(403,{'error':'仅支持本机访问'})
        route = urlsplit(self.path).path
        if route == '/api/health':
            return self.respond(200,{'ok':True,'local':True,'version':'0.2.0'})
        if route.startswith('/api/'):
            return self.respond(404,{'error':'接口不存在'})
        return super().do_GET()

    def do_POST(self):
        if not validate_origin(self.headers.get('Origin'),self.headers.get('Host'),self.server.server_port):
            return self.respond(403,{'error':'只接受本机网页同源上传'})
        if urlsplit(self.path).path != '/api/calculate':
            return self.respond(404,{'error':'接口不存在'})
        if self.headers.get_content_type() != 'application/json':
            return self.respond(415,{'error':'上传须使用 JSON'})
        try:
            size = int(self.headers.get('Content-Length','0'))
        except ValueError:
            size = 0
        if not 0 < size <= MAX_REQUEST:
            return self.respond(413,{'error':'上传请求为空或过大，请将文件总大小控制在 60 MB 内'})
        if not CALCULATION_LOCK.acquire(blocking=False):
            return self.respond(409,{'error':'本机正在处理另一批数据，请稍后再试'})
        try:
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload,dict):
                raise ValueError('上传内容必须是对象')
            result = calculate_and_build(payload)
            self.respond(200,result)
        except (ValueError,KeyError,zipfile.BadZipFile) as exc:
            self.respond(400,{'error':str(exc)})
        except Exception as exc:
            self.respond(500,{'error':f'计算未完成：{exc}'})
        finally:
            CALCULATION_LOCK.release()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=4180)
    parser.add_argument('--open',action='store_true')
    parser.add_argument('--no-build',action='store_true',help='仅用于已构建版本的开发预览')
    args=parser.parse_args()
    if not (ROOT/'dashboard/src/data.json').exists():
        shutil.copyfile(ROOT/'templates/dashboard-snapshot.json',ROOT/'dashboard/src/data.json')
    if not args.no_build:
        build_dashboard()
    server=ThreadingHTTPServer(('127.0.0.1',args.port),partial(Handler,directory=str(ROOT/'dashboard/dist')))
    print(f'Wind analysis: http://127.0.0.1:{args.port}/?view=1&tab=dashboard',flush=True)
    print('Keep this window open. Press Ctrl+C to stop. Data stays on this computer.',flush=True)
    if args.open:
        webbrowser.open(f'http://127.0.0.1:{args.port}/?view=1&tab=dashboard')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__=='__main__':
    import zipfile
    main()
