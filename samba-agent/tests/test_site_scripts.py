"""사이트 스크립트 묶음 내보내기·읽기."""

import json
from pathlib import Path

from samba_agent.ops.site_scripts import export_bundle, load_app_scripts, read_bundle


def _app_file(tmp_path: Path, scripts: object) -> Path:
    path = tmp_path / 'site-scripts.json'
    path.write_text(json.dumps(scripts, ensure_ascii=False), encoding='utf-8')
    return path


def test_export_then_read_round_trip(tmp_path: Path) -> None:
    source = _app_file(
        tmp_path,
        [
            {
                'name': 'b_script',
                'host': 'b.example',
                'description': '둘째',
                'params': ['sku'],
                'code': 'return 2',
                'runs': 9,
            },
            {'name': 'a_script', 'host': 'a.example', 'code': 'return 1\n// 한글 주석'},
        ],
    )
    target = tmp_path / 'bundle'

    assert export_bundle(source, target) == 2

    index = json.loads((target / 'index.json').read_text(encoding='utf-8'))
    assert [e['name'] for e in index] == ['a_script', 'b_script']
    assert 'runs' not in index[1]
    bundle = read_bundle(target)
    assert bundle[0]['code'] == 'return 1\n// 한글 주석'
    assert bundle[1]['params'] == ['sku']


def test_export_removes_scripts_deleted_in_app(tmp_path: Path) -> None:
    target = tmp_path / 'bundle'
    export_bundle(_app_file(tmp_path, [{'name': 'old', 'code': 'x'}, {'name': 'keep', 'code': 'y'}]), target)

    export_bundle(_app_file(tmp_path, [{'name': 'keep', 'code': 'y2'}]), target)

    assert not (target / 'old.js').exists()
    assert (target / 'keep.js').read_text(encoding='utf-8') == 'y2'


def test_load_accepts_wrapped_and_keyed_shapes(tmp_path: Path) -> None:
    wrapped = _app_file(tmp_path, {'scripts': [{'name': 'a', 'code': 'x'}]})
    assert [s['name'] for s in load_app_scripts(wrapped)] == ['a']
    keyed = _app_file(tmp_path, {'a': {'name': 'a', 'code': 'x'}, 'b': {'name': 'b', 'code': ''}})
    assert [s['name'] for s in load_app_scripts(keyed)] == ['a']


def test_export_skips_unsafe_names(tmp_path: Path) -> None:
    target = tmp_path / 'bundle'
    source = _app_file(tmp_path, [{'name': '../evil', 'code': 'x'}, {'name': 'ok', 'code': 'y'}])

    assert export_bundle(source, target) == 1
    assert [p.name for p in target.glob('*.js')] == ['ok.js']
