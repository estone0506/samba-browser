# 설정 로딩 — 비밀은 가려지고, 없는 값은 기본값으로, 필수 값이 없으면 바로 실패한다
import pytest
from pydantic import ValidationError

from samba_agent.failures import FailReason
from samba_agent.settings import load_settings


def test_env_에서_읽고_기본값을_채운다(monkeypatch):
    monkeypatch.setenv('SAMBA_BRIDGE_TOKEN', 'f' * 64)
    s = load_settings(env_file=None)
    assert s.bridge_url == 'http://127.0.0.1:47811'
    assert s.harness_env == 'dev'
    assert s.slack_channel == '#sambaorder'
    assert s.dry_run is True  # 기본은 dry-run. 외부 변경은 명시로만


def test_비밀은_문자열로_새지_않는다(monkeypatch):
    monkeypatch.setenv('SAMBA_BRIDGE_TOKEN', 'abcd' * 16)
    s = load_settings(env_file=None)
    assert 'abcd' not in repr(s)
    assert 'abcd' not in str(s)
    assert s.bridge_token.get_secret_value() == 'abcd' * 16


def test_토큰이_없으면_실패한다(monkeypatch):
    monkeypatch.delenv('SAMBA_BRIDGE_TOKEN', raising=False)
    with pytest.raises(ValidationError):
        load_settings(env_file=None)


def test_실패_사유는_스펙_9종에_결제_중단을_더한_10종이다():
    assert {r.value for r in FailReason} == {
        'out_of_stock',
        'margin',
        'card_missing',
        'captcha',
        'bridge_down',
        'permission_denied',
        'duplicate',
        'verify_mismatch',
        'unknown',
        'pay_interrupted',
    }


def test_판정_산출물_위치는_설정_하나로_정해진다(monkeypatch, tmp_path):
    # 리뷰 지적 — I4: gate 는 패키지 안, API 는 root 밑을 보고 있었다
    from samba_agent.ops import eval as eval_mod
    from samba_agent.ops import gate as gate_mod
    from samba_agent.settings import DEFAULT_ROOT, default_report_dir

    assert gate_mod.REPORT_DIR == eval_mod.REPORT_DIR == default_report_dir()
    assert default_report_dir() == DEFAULT_ROOT / 'ops' / 'reports'
    monkeypatch.setenv('SAMBA_REPORT_DIR', str(tmp_path / 'r'))
    assert default_report_dir() == tmp_path / 'r'
