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


def test_처리하지마는_unknown이다():
    # '처리' 로 시작한다고 다 처리 명령이 아니다 — 화이트리스트만 인정한다(리뷰 지적 — Minor 4)
    assert parse_command('<@BOT> A1 처리하지마').kind == 'unknown'


@pytest.mark.parametrize('word', ['처리해', '처리해줘', '처리', 'process'])
def test_처리_화이트리스트_단어는_모두_인식한다(word):
    c = parse_command(f'<@BOT> A1 {word}')
    assert (c.kind, c.order_no) == ('process', 'A1')


@pytest.mark.parametrize('digits', ['12345678', '1' * 9, '1' * 21, '1' * 25])
def test_주문번호_숫자_자릿수가_범위_밖이면_unknown(digits):
    # 숫자 주문번호는 10~20자리만 인정한다(리뷰 지적 — Minor 5)
    assert parse_command(f'<@BOT> {digits} 처리해').kind == 'unknown'


@pytest.mark.parametrize('digits', ['1' * 10, '1' * 20, '734501000740906'])
def test_주문번호_숫자_자릿수_경계값은_인식한다(digits):
    c = parse_command(f'<@BOT> {digits} 처리해')
    assert (c.kind, c.order_no) == ('process', digits)


@pytest.mark.parametrize(
    ('text', 'order_no'),
    [
        ('<@BOT> process ABC12345', 'ABC12345'),
        ('<@BOT> 처리해 ABC12345', 'ABC12345'),
        ('<@BOT> 처리 ABC12345', 'ABC12345'),
        ('<@BOT> ABC12345 처리해줘', 'ABC12345'),
    ],
)
def test_명령어_토큰을_주문번호로_읽지_않는다(text, order_no):
    # 리뷰 지적 — I9: `process ABC12345` 가 order_no='process' 로 읽혔다
    c = parse_command(text)
    assert (c.kind, c.order_no) == ('process', order_no)


def test_주문번호_안의_글자를_카드로_읽지_않는다():
    # 리뷰 지적 — I9: 'ABC12345' 안의 'BC' 를 BC카드로 읽었다
    c = parse_command('<@BOT> process ABC12345')
    assert c.options == {}


@pytest.mark.parametrize(
    ('text', 'card'),
    [
        ('<@BOT> A1 처리해 BC카드', 'BC'),
        ('<@BOT> A1 처리해 BC', 'BC'),
        ('<@BOT> 734501000740906 처리해 현대카드로', '현대'),
    ],
)
def test_카드는_단어_경계로만_읽는다(text, card):
    assert parse_command(text).options == {'card': card}
