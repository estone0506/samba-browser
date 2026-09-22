"""개인정보 마스킹 — LangSmith 로 나가기 전에 무조건 통과한다(스펙 §3, §4.5).

가리는 것: 고객 이름 · 전화 · 주소 · 이메일.
가리지 않는 것: 주문번호 · 금액 · 판단 근거 — 진단과 채점이 이 값을 봐야 한다.
비밀번호·카드번호·토큰은 애초에 상태에 없다(앱 도구가 값을 돌려주지 않는다).
"""

import re

MASK = '***'

# (이름, 정규식) — 새 형식이 생기면 여기 한 줄을 더한다
PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ('email', re.compile(r'\b[\w.+-]+@[\w-]+\.[\w.-]+\b')),
    ('phone', re.compile(r'\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b')),
    (
        'address',
        re.compile(
            r'(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)'
            r'[가-힣]*(특별시|광역시|특별자치시|특별자치도|도)?\s*[가-힣]+(시|군|구)\s*[^\n,]{2,40}'
        ),
    ),
    ('name', re.compile(r'(수취인|받는분|받는 분|수령인|주문자)\s*[:：]?\s*[가-힣]{2,4}')),
)


def mask_text(text: str) -> str:
    """문자열 1건을 가린다. 이름 표시는 라벨을 남겨 무엇이 가려졌는지 보이게 한다."""
    out = text
    for name, pattern in PATTERNS:
        if name == 'name':
            out = pattern.sub(lambda m: f'{m.group(1)} {MASK}', out)
        else:
            out = pattern.sub(MASK, out)
    return out


def mask_value(value: object) -> object:
    """사전·목록·문자열을 재귀로 가린다. 숫자는 그대로 둔다(금액이 필요하다)."""
    if isinstance(value, str):
        return mask_text(value)
    if isinstance(value, dict):
        return {k: mask_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [mask_value(v) for v in value]
    return value


def find_leaks(value: object) -> list[str]:
    """아직 남아 있는 개인정보 종류. 완료 조건 검사(정규식 0건)에 쓴다."""
    text = str(value)
    return [name for name, pattern in PATTERNS if pattern.search(text)]
