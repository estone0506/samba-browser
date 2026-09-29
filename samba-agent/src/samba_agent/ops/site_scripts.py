"""사이트 스크립트 묶음 내보내기·가져오기.

사이트 스크립트는 앱 데이터 폴더(`%APPDATA%/SAMBA Browser/site-scripts.json`)에만 저장된다 — 저장소를 받아도
스크립트가 없으면 하네스가 돌지 않는다. 이 도구가 스크립트를 저장소 폴더(`samba-agent/site-scripts/`)로
내보내고, 다른 PC 에서는 그 폴더를 앱에 다시 넣는다.

    python -m samba_agent.ops.site_scripts export   # 앱 → 저장소 폴더
    python -m samba_agent.ops.site_scripts import   # 저장소 폴더 → 앱(브릿지 save_script)

묶음에는 코드·호스트·설명·인자만 담는다(실행 횟수·시각은 PC 마다 달라 뺀다).
"""

import json
import os
import re
import sys
import time
from pathlib import Path

import httpx

from samba_agent import local_aliases

BUNDLE_DIR = Path(__file__).resolve().parents[3] / 'site-scripts'
INDEX_NAME = 'index.json'
BRIDGE_URL = 'http://127.0.0.1:47811'
# 브릿지 save_script 는 다른 레인이 쓰는 동안 409 를 준다 — 기다렸다 다시 부른다
BUSY_RETRIES = 120
NAME_RE = re.compile(r'^[A-Za-z0-9_\-]+$')


def app_scripts_path() -> Path:
    """앱이 스크립트를 저장하는 파일."""
    base = os.environ.get('SAMBA_APP_DATA') or os.path.join(
        os.environ.get('APPDATA', ''), 'SAMBA Browser'
    )
    return Path(base) / 'site-scripts.json'


def load_app_scripts(path: Path) -> list[dict[str, object]]:
    """앱 저장 파일을 스크립트 목록으로 읽는다(목록·{scripts:[…]}·{이름:…} 세 모양을 받는다)."""
    raw = json.loads(path.read_text(encoding='utf-8'))
    if isinstance(raw, dict):
        raw = raw.get('scripts', raw)
    items = raw if isinstance(raw, list) else list(raw.values())
    return [s for s in items if isinstance(s, dict) and s.get('name') and s.get('code')]


def export_bundle(source: Path, target: Path = BUNDLE_DIR) -> int:
    """앱의 스크립트를 저장소 폴더에 쓴다. 쓴 개수를 돌려준다. 앱에서 지운 스크립트 파일은 폴더에서도 지운다."""
    scripts = sorted(load_app_scripts(source), key=lambda s: str(s['name']))
    target.mkdir(parents=True, exist_ok=True)
    index: list[dict[str, object]] = []
    kept: set[str] = set()
    for s in scripts:
        name = str(s['name'])
        if not NAME_RE.match(name):
            print(f'건너뜀(이름에 쓸 수 없는 글자): {name}')
            continue
        # 저장소에는 가명으로 쓴다 — 주석에 든 계정·주소가 공개되지 않게(local_aliases)
        code = local_aliases.conceal(str(s['code']))
        (target / f'{name}.js').write_text(code, encoding='utf-8', newline='\n')
        kept.add(f'{name}.js')
        index.append(
            {
                'name': name,
                'host': s.get('host'),
                'description': local_aliases.conceal(str(s.get('description') or '')) or None,
                'params': s.get('params') or [],
            }
        )
    for old in target.glob('*.js'):
        if old.name not in kept:
            old.unlink()
    (target / INDEX_NAME).write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n'
    )
    return len(index)


def read_bundle(source: Path = BUNDLE_DIR) -> list[dict[str, object]]:
    """저장소 폴더의 묶음을 스크립트 목록으로 읽는다."""
    index = json.loads((source / INDEX_NAME).read_text(encoding='utf-8'))
    out: list[dict[str, object]] = []
    for entry in index:
        code_path = source / f'{entry["name"]}.js'
        if not code_path.exists():
            print(f'건너뜀(코드 파일 없음): {entry["name"]}')
            continue
        out.append({**entry, 'code': code_path.read_text(encoding='utf-8')})
    return out


def import_bundle(token: str, source: Path = BUNDLE_DIR, url: str = BRIDGE_URL) -> tuple[int, int]:
    """묶음을 앱에 넣는다(브릿지 save_script). (넣은 개수, 실패 개수)를 돌려준다."""
    headers = {'X-Samba-Token': token, 'X-Samba-Lane': 'save'}
    done = failed = 0
    with httpx.Client(timeout=60) as client:
        for s in read_bundle(source):
            args = {k: s.get(k) for k in ('name', 'host', 'description', 'params', 'code')}
            answer = ''
            for _ in range(BUSY_RETRIES):
                r = client.post(f'{url}/tool/save_script', json={'args': args}, headers=headers)
                if r.status_code != 409:
                    answer = str(r.json().get('result') or r.text)
                    break
                time.sleep(1)
            if answer.startswith(('saved', 'updated')):
                done += 1
            else:
                failed += 1
                print(f'실패: {s["name"]} — {answer[:120]}')
    return done, failed


def missing_in_app(bundle: list[dict[str, object]], app_path: Path) -> list[dict[str, object]]:
    """묶음에는 있고 앱에는 없는 스크립트. 앱 파일을 못 읽으면(첫 실행) 묶음 전부다."""
    try:
        have = {str(s['name']) for s in load_app_scripts(app_path)}
    except (OSError, ValueError):
        have = set()
    return [s for s in bundle if str(s['name']) not in have]


def install_missing(token: str, url: str = BRIDGE_URL, source: Path = BUNDLE_DIR) -> int:
    """앱에 없는 스크립트만 넣는다(있는 것은 이 PC 에서 고쳤을 수 있어 덮어쓰지 않는다). 넣은 개수를 돌려준다.

    하네스가 시작할 때 부른다 — 저장소를 받아 앱과 하네스만 켜면 스크립트가 채워진다.
    """
    if not (source / INDEX_NAME).exists():
        return 0
    todo = missing_in_app(read_bundle(source), app_scripts_path())
    if not todo:
        return 0
    headers = {'X-Samba-Token': token, 'X-Samba-Lane': 'save'}
    done = 0
    with httpx.Client(timeout=60) as client:
        for s in todo:
            args = {k: s.get(k) for k in ('name', 'host', 'description', 'params')}
            args['code'] = local_aliases.apply(str(s['code']))
            for _ in range(BUSY_RETRIES):
                r = client.post(f'{url}/tool/save_script', json={'args': args}, headers=headers)
                if r.status_code != 409:
                    if str(r.json().get('result') or '').startswith(('saved', 'updated')):
                        done += 1
                    break
                time.sleep(1)
    return done


def _bridge_token() -> str:
    """브릿지 토큰 — 환경변수, 없으면 작업 폴더 .env."""
    token = os.environ.get('SAMBA_BRIDGE_TOKEN', '')
    if not token and Path('.env').exists():
        m = re.search(
            r'^SAMBA_BRIDGE_TOKEN="?([^"\r\n]+)', Path('.env').read_text(encoding='utf-8'), re.MULTILINE
        )
        token = m.group(1) if m else ''
    return token


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else ''
    if command == 'export':
        source = app_scripts_path()
        if not source.exists():
            print(f'앱 스크립트 파일이 없다: {source}')
            return 1
        print(f'{export_bundle(source)}개를 {BUNDLE_DIR} 에 썼다')
        return 0
    if command == 'import':
        token = _bridge_token()
        if not token:
            print('브릿지 토큰이 없다(SAMBA_BRIDGE_TOKEN) — 앱을 켜고 .env 를 채운 뒤 다시 실행')
            return 1
        done, failed = import_bundle(token)
        print(f'넣음 {done}개 · 실패 {failed}개')
        return 1 if failed else 0
    print('사용법: python -m samba_agent.ops.site_scripts export|import')
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
