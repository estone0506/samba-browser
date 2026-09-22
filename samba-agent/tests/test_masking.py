# 마스킹 — 개인정보는 가리고 주문·금액·근거는 남긴다
from samba_agent.ops.masking import MASK, find_leaks, mask_text, mask_value
from samba_agent.supervisor.state import sanitize_payload


def test_전화번호를_가린다():
    assert '010' not in mask_text('연락처 010-1234-5678 입니다')
    assert MASK in mask_text('연락처 01012345678')


def test_이메일을_가린다():
    assert mask_text('kim@example.com 으로 보냄').startswith(MASK)


def test_주소와_수취인을_가린다():
    out = mask_text('수취인 홍길동 · 서울특별시 강남구 테헤란로 123 4층')
    assert '홍길동' not in out
    assert '테헤란로' not in out


def test_주문번호와_금액과_근거는_남는다():
    text = '주문 734501000740906 원가 89,000원 — 260 사이즈가 주문과 일치'
    assert mask_text(text) == text


def test_중첩된_값도_재귀로_가린다():
    got = mask_value({'order_no': 'A1', 'buyer': {'phone': '010-1111-2222', 'cost': 89000}})
    assert got['order_no'] == 'A1'
    assert got['buyer']['cost'] == 89000
    assert '010' not in str(got['buyer']['phone'])


def test_검사기는_남은_개인정보를_찾아낸다():
    assert find_leaks({'a': '010-1111-2222'}) == ['phone']
    assert find_leaks(mask_value({'a': '010-1111-2222'})) == []


def test_주소가_같은_줄의_주문번호를_삼키지_않는다():
    text = '수취인 홍길동 · 서울특별시 강남구 테헤란로 123 주문번호 734501000740906'
    out = mask_text(text)
    assert '734501000740906' in out
    assert '홍길동' not in out
    assert '테헤란로' not in out


def test_한글에_바로_붙은_전화번호도_가린다():
    assert '010' not in mask_text('연락처010-1234-5678입니다')


def test_점으로_구분한_전화번호도_가린다():
    assert '010' not in mask_text('010.1234.5678')


def test_고객명_라벨과_이름님_호칭도_가린다():
    assert '홍길동' not in mask_text('고객명 홍길동')
    assert '홍길동' not in mask_text('홍길동님 주문이 접수되었습니다')


def test_이름을_가려도_주문번호와_금액은_남는다():
    text = '홍길동님 주문 734501000740906 원가 89,000원 결제 완료'
    out = mask_text(text)
    assert '734501000740906' in out
    assert '89,000' in out
    assert '홍길동' not in out


def test_내부_판매_계정은_state에서_가리지_않는다():
    # 리뷰 지적 — I1: 이메일 꼴 내부 계정이 '***' 로 뭉개지면 기록 에이전트가 빈 계정을 저장한다.
    # 마스킹은 고객 개인정보(이름·전화·주소·이메일)용이다 — 우리 판매 계정은 대상이 아니다.
    out = sanitize_payload({'account': 'samba01@wave.co.kr', 'memo': '수취인 홍길동 010-1234-5678'})
    assert out['account'] == 'samba01@wave.co.kr'
    assert '홍길동' not in str(out['memo'])
    assert '010-1234-5678' not in str(out['memo'])
