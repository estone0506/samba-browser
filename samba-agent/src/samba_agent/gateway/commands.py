"""슬랙 명령 파싱. 슬랙 SDK 를 모르는 순수 함수라 테스트가 쉽다(스펙 §4.1)."""

import re
from dataclasses import dataclass, field
from typing import Literal

CommandKind = Literal[
    'process', 'status', 'cancel', 'resume', 'diagnose', 'version', 'approve', 'unknown'
]

# 주문번호는 숫자 10~20자리(무신사 등 실 주문번호 자릿수) 또는 2~32자 영문+숫자 혼합 코드
ORDER_RE = re.compile(r'\b([0-9]{10,20}|[A-Za-z][A-Za-z0-9_-]{1,31})\b')
MENTION_RE = re.compile(r'<@[A-Z0-9]+>')
VERSION_RE = re.compile(r'\bv[0-9a-f]{12}\b')
KNOWN_CARDS = ('현대', '삼성', '신한', '국민', '롯데', '하나', 'BC', '농협')
# '처리' 로 시작하는 아무 말이나 잡으면 "처리하지마" 도 명령으로 오인한다 — 화이트리스트로 좁힌다
PROCESS_WORDS = ('처리해', '처리해줘', '처리', 'process')
# 주문번호 자리에 올 수 없는 말 — 명령어 자체가 주문번호로 읽히면 안 된다(리뷰 지적 — I9)
COMMAND_WORDS = frozenset(PROCESS_WORDS) | {'상태', '버전', '승인', '취소', '이어서', '진단'}


@dataclass(frozen=True)
class Command:
    """한 줄 명령의 해석 결과."""

    kind: CommandKind
    order_no: str | None = None
    options: dict[str, str] = field(default_factory=dict)
    version: str | None = None


def _first_order(words: list[str]) -> str | None:
    """첫 주문번호. 명령어 토큰(`process`·`처리해` …)은 건너뛴다(리뷰 지적 — I9)."""
    for w in words:
        if w in COMMAND_WORDS:
            continue
        m = ORDER_RE.fullmatch(w)
        if m:
            return m.group(1)
    return None


def _card_option(words: list[str]) -> str | None:
    """카드 이름. 단어 그 자체이거나 `○○카드…` 꼴일 때만 읽는다.

    부분 문자열로 찾으면 주문번호 'ABC12345' 안의 'BC' 가 BC카드가 된다(리뷰 지적 — I9).
    """
    for w in words:
        for card in KNOWN_CARDS:
            if w == card or w.startswith(f'{card}카드'):
                return card
    return None


def parse_command(text: str) -> Command:
    """`@삼바 …` 한 줄 → Command. 모르는 말은 unknown(봇은 답하지 않는다)."""
    body = MENTION_RE.sub(' ', text).strip()
    words = [w for w in body.split() if w]
    if not words:
        return Command('unknown')
    head = words[0]
    rest = words[1:]
    if head == '상태':
        return Command('status')
    if head == '버전':
        return Command('version')
    if head == '승인':
        m = VERSION_RE.search(' '.join(rest))
        return Command('approve', version=m.group(0)) if m else Command('unknown')
    if head in ('취소', '이어서', '진단'):
        order = _first_order(rest)
        kind: CommandKind = {'취소': 'cancel', '이어서': 'resume', '진단': 'diagnose'}[head]
        return Command(kind, order_no=order) if order else Command('unknown')
    if any(w in PROCESS_WORDS for w in words):
        order = _first_order(words)
        if not order:
            return Command('unknown')
        card = _card_option(words)
        options: dict[str, str] = {'card': card} if card else {}
        return Command('process', order_no=order, options=options)
    return Command('unknown')
