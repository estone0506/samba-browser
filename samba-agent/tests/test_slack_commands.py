# 명령 파싱 — 6종 + 승인 / 잘못된 명령 / 카드 옵션
import pytest

from samba_agent.gateway.commands import parse_command


@pytest.mark.parametrize(
    'text,kind,order_no',
    [
        ('<@BOT> 734501000740906 처리해', 'process', '734501000740906'),
        ('<@BOT> 상태', 'status', None),
        ('<@BOT> 취소 734501000740906', 'cancel', '734501000740906'),
        ('<@BOT> 이어서 734501000740906', 'resume', '734501000740906'),
        ('<@BOT> 진단 734501000740906', 'diagnose', '734501000740906'),
        ('<@BOT> 버전', 'version', None),
    ],
)
def test_명령_6종(text, kind, order_no):
    c = parse_command(text)
    assert (c.kind, c.order_no) == (kind, order_no)


def test_카드를_옵션으로_읽는다():
    c = parse_command('<@BOT> 734501000740906 처리해 현대카드')
    assert c.kind == 'process'
    assert c.options == {'card': '현대'}


def test_승인은_버전을_읽는다():
    c = parse_command('<@BOT> 승인 vab12cd34ef56')
    assert (c.kind, c.version) == ('approve', 'vab12cd34ef56')


@pytest.mark.parametrize('text', ['<@BOT> 안녕', '<@BOT>', '<@BOT> 처리해', '<@BOT> 취소'])
def test_모르는_명령은_unknown(text):
    assert parse_command(text).kind == 'unknown'
