# harness_version — 감독자 코드·등록부·규칙·프롬프트 커밋 중 무엇이든 바뀌면 새 버전
from samba_agent.version import harness_version


def _root(tmp_path):
    (tmp_path / 'rules').mkdir()
    (tmp_path / 'registry.yaml').write_text('agents: []\n', encoding='utf-8')
    (tmp_path / 'rules' / 'payer.md').write_text('결제 규칙\n', encoding='utf-8')
    return tmp_path


def test_같은_입력이면_같은_버전(tmp_path):
    root = _root(tmp_path)
    assert harness_version(root, {'payer': 'c1'}) == harness_version(root, {'payer': 'c1'})
    assert harness_version(root, {'payer': 'c1'}).startswith('v')
    assert len(harness_version(root, {'payer': 'c1'})) == 13


def test_규칙_파일이_바뀌면_새_버전(tmp_path):
    root = _root(tmp_path)
    before = harness_version(root, {'payer': 'c1'})
    (root / 'rules' / 'payer.md').write_text('결제 규칙 2\n', encoding='utf-8')
    assert harness_version(root, {'payer': 'c1'}) != before


def test_프롬프트_커밋이_바뀌면_새_버전(tmp_path):
    root = _root(tmp_path)
    assert harness_version(root, {'payer': 'c1'}) != harness_version(root, {'payer': 'c2'})
