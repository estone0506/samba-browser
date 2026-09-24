"""구매 에이전트 — 소싱처에서 옵션·계정·배송지·결제수단을 정하는 데까지만 한다.

결제창 진입과 결제 버튼은 결제 에이전트 담당이다(등록부 tools 에 결제 도구가 없다).
사이트 차이는 등록부의 저장 스크립트 이름과 rules/*.md 가 흡수한다.
"""

import json
import re
import time
from collections.abc import Callable
from urllib.parse import urlparse

from samba_agent.agents.base import (
    AgentBase,
    AgentFailure,
    Decision,
    run_agent,
    split_page_dialogs,
)
from samba_agent.agents.contracts import AgentResult, Assignment, OrderRef
from samba_agent.agents.registry import AgentSpec
from samba_agent.failures import FailReason
from samba_agent.ops.masking import mask_text
from samba_agent.sources import Source, default_sources
from samba_agent.supervisor.policy import is_poison_seller
from samba_agent.wave.client import WaveError

# (주문번호, 배송 종류) → 배송지 사전. 배송 종류는 소싱처 강제값이 있으면 그것, 없으면 주문의 값.
# 개인정보라 반환값은 호출 안에서만 쓰고 버린다
ShippingFn = Callable[[str, str], dict[str, object]]

# 로그인 아이디로 볼 수 있는 모양(ASCII 영숫자·._-). 한글 별명은 여기 걸리지 않는다
_LOGIN_ID = re.compile(r'[A-Za-z0-9._\-@]+')


def source_of(agent_name: str) -> Source:
    """'buyer.abc' → 소싱처 표(sources.yaml)의 행. 표에 없는 이름은 등록부가 만들지 않는다."""
    source = default_sources().by_agent(agent_name)
    if source is None:
        raise AgentFailure(
            'needs_human', f'소싱처 표에 없는 에이전트: {agent_name}', FailReason.UNKNOWN
        )
    return source


def product_ref(agent_name: str, order: OrderRef) -> str:
    """스냅샷 스크립트의 sku 인자 — 상품 ID > 상품 URL > 판매 상품명 순으로 확실한 것을 쓴다."""
    if order.product_url:
        spec = source_of(agent_name)
        # 같은 구매자가 여러 호스트를 맡는 경우(ABC 구매자가 그랜드스테이지 주문도 산다) 상품 ID 만 넘기면
        # 스크립트가 제 호스트(abcmart) 주소를 만들어 엉뚱한 상품(품절 오판)을 연다 — 호스트가 다르면 URL 을 그대로 준다
        if not _same_host(order.product_url, spec.home):
            return order.product_url
        pattern = spec.product_id_re
        m = pattern.search(order.product_url) if pattern else None
        return m.group(1) if m else order.product_url
    return order.sku


def _same_host(url: str, home: str | None) -> bool:
    """두 주소의 호스트(www. 제외)가 같은가. home 이 없으면 같다고 본다."""
    if not home:
        return True
    a = (urlparse(url).hostname or '').removeprefix('www.')
    b = (urlparse(home).hostname or '').removeprefix('www.')
    return a == b


def _norm(text: str) -> str:
    """옵션 비교용 정규화 — 공백·구두점 제거, 소문자."""
    return re.sub(r'[\s\-_/·,()\[\]]+', '', text).lower()


# 주소 비교용 — 사이트가 우편번호 검색으로 바꿔 놓는 표기 차이("서울특별시"→"서울", 뒤에 "(태평로1가)" 붙음)를 지운다
_ADDR_DROP = re.compile(r'\([^)]*\)|특별자치도|특별자치시|특별시|광역시|자치|\s+')


def _norm_address(text: str) -> str:
    return _ADDR_DROP.sub('', text).lower()


def shipping_matches(expected: dict[str, object], applied: dict[str, object]) -> bool:
    """넣은 배송지와 사이트가 되읽어 준 배송지가 같은 곳인가.

    이름은 공백을 뺀 정확 일치. 주소는 사이트 표기 차이를 지운 뒤 한쪽이 다른 쪽을 품거나,
    도로명·건물번호 등 숫자 토큰이 모두 같아야 한다(실기: 무신사가 "서울특별시 중구 세종대로 110" 을
    "서울 중구 세종대로 110 (서울특별시청)" 으로 되읽어 정확 비교가 어긋났다).
    """
    if _norm(str(expected.get('name', ''))) != _norm(str(applied.get('name', ''))):
        return False
    # 우편번호가 양쪽에 있고 같으면 같은 곳이다 — 지번(41-11)을 도로명(14번길 11)으로 되읽는 사이트(실기: 롯데온)는
    # 숫자 토큰이 달라진다
    zip_exp = re.sub(r'\D', '', str(expected.get('postal_code') or ''))
    zip_app = re.sub(r'\D', '', str(applied.get('zip') or applied.get('postal_code') or ''))
    if zip_exp and zip_app and zip_exp == zip_app and str(applied.get('address') or '').strip():
        return True
    a = _norm_address(str(expected.get('address', '')))
    b = _norm_address(str(applied.get('address', '')))
    if not a or not b:
        return False
    if a in b or b in a:
        return True
    return re.findall(r'\d+', a) == re.findall(r'\d+', b) and a[-6:] in b


# 결제수단 이름 → 키마스터 결제 제공자(src/shared/vault.ts PaymentProvider). 앞에서부터 먼저 맞는 것
QUOTE_PROVIDER_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ('musinsapay', ('무신사페이',)),
    ('toss', ('토스', 'toss')),
    ('kakao', ('카카오', 'kakao')),
    ('naver', ('네이버', 'naver')),
    ('payco', ('페이코', 'payco')),
    ('samsung', ('삼성페이', 'samsung')),
    ('apple', ('애플', 'apple')),
    # 사이트 자체 결제(웹에서 끝나는 결제) — 무신사머니·SSG PAY·L.pay·스마일페이 등
    ('site', ('머니', 'ssg pay', 'ssgpay', 'l.pay', 'lpay', '엘페이', '스마일', 'smile', '포인트')),
    # 주문서의 '카드'(직접 결제)는 쓰지 않는다 — 결제 가능 수단에 절대 들어가지 않게 표에서 뺀다
)


def quote_provider(method: str, card: str | None = None) -> str | None:
    """견적 한 줄의 결제수단(카드사 포함)이 어느 결제 제공자인지. 모르면 None(결제 불가로 본다)."""
    text = f'{method} {card or ""}'.lower()
    for provider, keywords in QUOTE_PROVIDER_KEYWORDS:
        if any(k in text for k in keywords):
            return provider
    return None


def parse_account_payments(raw: str, label: str) -> set[str] | None:
    """앱 list_accounts 결과에서 그 계정의 결제 가능 제공자 집합. 계정을 못 찾거나 형식이 아니면 None.

    payments(결제 비밀번호 항목의 제공자)만 본다. 카드 직접 결제는 쓰지 않는다(카드는 간편결제 창 안에서 고른다).
    """
    body, _ = split_page_dialogs(raw)
    try:
        parsed = json.loads(body)
    except ValueError:
        return None
    items: object = parsed.get('accounts') if isinstance(parsed, dict) else parsed
    if not isinstance(items, list):
        return None
    for item in items:
        if not isinstance(item, dict) or str(item.get('label') or '').strip() != label:
            continue
        payments = item.get('payments')
        return {str(x) for x in payments} if isinstance(payments, list) else set()
    return None


def payable_methods(methods: list[str], payable: set[str]) -> list[str]:
    """주문서에 보이는 결제수단 이름 중 키마스터로 낼 수 있는 것만(사이트 표기 그대로). 순서는 화면 순서."""
    return [m for m in methods if (quote_provider(m) or '') in payable]


def cheapest_quotes(
    raw: object, wanted_card: str | None, payable: set[str] | None = None
) -> list[dict[str, object]]:
    """결제수단 견적 목록을 싼 순으로 정리한다. 금액이 없거나 0 이하인 줄은 뺀다.

    payable 이 주어지면 그 제공자로 낼 수 있는 줄만 남긴다(키마스터에 결제 비밀번호·카드가 있는 수단).
    요청자가 카드(수단 이름 또는 카드사 이름 일부)를 지정했으면 그것이 들어간 줄만 남긴다.
    같은 금액이면 목록 앞(사이트가 기본으로 보여 준 순서)이 먼저다.
    """
    if not isinstance(raw, list):
        return []
    rows: list[dict[str, object]] = []
    for q in raw:
        if not isinstance(q, dict):
            continue
        cost = _as_float(q.get('cost'))
        method = str(q.get('method') or '').strip()
        if cost <= 0 or not method:
            continue
        card = str(q.get('card') or '').strip() or None
        if q.get('available') is False or q.get('allowed') is False or q.get('registered') is False:
            # 낼 수 없는 수단(무신사머니 연결 계좌 없음·잔액 부족), 허용 안 된 조합(토스페이×계좌 등), 미등록 카드
            continue
        if payable is not None:
            provider = quote_provider(method, card)
            if provider is None or provider not in payable:
                continue
        if wanted_card:
            w = wanted_card.strip()
            if w not in method and (card is None or w not in card):
                continue
        rows.append(
            {
                'method': method,
                'card': card,
                'paid': cost,
                'reward': _as_float(q.get('reward')),
                'points_used': _as_float(q.get('points_used')),
                'cost': effective_cost({**q, 'cost': cost, 'card': card}),
            }
        )
    return sorted(rows, key=lambda r: float(r['cost']))


# 포이즌 외 마켓의 까대기 건 배송비(삼바웨이브 기록, 원). 사무실 경유 재발송비 — poizon-sourcing 스킬 규칙
KKADAEGI_SHIPPING_FEE = 2300
# 사무실 주소 표식 — 까대기의 기본 배송지가 이 주소여야 한다(경북 가상시 사무실길 58)
OFFICE_ADDRESS_HINT = '사무실길 58'
# 까대기 주문 배송지(사무실). 기본 배송지가 사무실이 아닐 때 이번 주문에만 넣는다 — poizon-sourcing 스킬 "사무실 배송"
OFFICE_SHIPPING: dict[str, object] = {
    'name': '김사무',
    'address': '경북 가상시 사무실길 58',
    'address_detail': '1층 102호',
    'postal_code': '38069',
}
# 카드 청구할인(플레이북 §7): 결제창에 안 보이는 카드 대금 할인 — 원가 = 카드 결제액 × 계수 − 적립
CARD_BILLING_FACTORS: tuple[tuple[tuple[str, ...], float], ...] = (
    (('현대',), 0.973),
    (('롯데', 'KB', '국민'), 0.98),
)


def billing_factor(card: str | None) -> float:
    """카드사 이름에 맞는 청구할인 계수. 없으면 1.0"""
    if not card:
        return 1.0
    for names, factor in CARD_BILLING_FACTORS:
        if any(n in card for n in names):
            return factor
    return 1.0


def effective_cost(row: dict[str, object]) -> float:
    """견적 한 줄의 원가(플레이북 §6): 실결제액 × 청구할인 계수 − 후기 제외 신규 적립 + 사용한 기존 적립금."""
    paid = _as_float(row.get('cost'))
    reward = _as_float(row.get('reward'))
    used = _as_float(row.get('points_used'))
    return round(paid * billing_factor(str(row.get('card') or '') or None) - reward + used)
# 결제창(토스페이·네이버페이) 안에서 고를 수 있는 카드사(사용자 2026-09-24: 현대·KB·롯데·신한·농협). 주문서 단계의
# '카드 직접 결제'는 쓰지 않는다 — 카드는 간편결제 창 안에서만 고른다. 결제 에이전트가 카드를 고를 때 이 표를 쓴다
ALLOWED_CARD_ISSUERS = ('현대', 'KB', '국민', '롯데', '신한', '농협', 'NH')


def decide_order_type(
    order: OrderRef, normal_price: float | None, forced: str | None = None
) -> tuple[str, str]:
    """이 주문을 직배/까대기 중 무엇으로 이행할지와 그 근거(poizon-sourcing 스킬 "대상과 처리 순서").

    - 소싱처가 강제하면(ABC마트·그랜드스테이지 = 까대기) 그것
    - 포이즌 판매건은 소싱처와 무관하게 까대기
    - 그 밖의 마켓(KT알파·롯데홈쇼핑·쿠팡 …)은 **소싱처 정가(세일가 아님)** 와 고객 결제액을 비교한다:
      정가 ≤ 고객 결제액 → 까대기(고객이 정가를 보면 클레임), 정가 > 고객 결제액 → 직배
    - 정가나 고객 결제액을 모르면 판정 불가(빈 문자열) — 호출부가 사람에게 넘긴다
    선물(gift) 태그가 있는 주문은 배송지 입력 흐름이 다르니 그대로 둔다.
    """
    if forced:
        return forced, f'소싱처 규칙({forced})'
    if order.order_type == 'gift':
        return 'gift', '선물 태그'
    if is_poison_seller(order.seller):
        return 'kkadaegi', '포이즌 판매건은 전부 까대기'
    if normal_price is None or normal_price <= 0:
        return '', '소싱처 정가를 읽지 못해 직배/까대기를 정할 수 없다'
    if order.sale_price <= 0:
        # 고객 결제액을 모르는 주문(삼바웨이브 판매가 0) — 비교할 수 없으니 태그를 따른다
        return order.order_type, '고객 결제액을 몰라 삼바웨이브 태그를 따름'
    if normal_price <= order.sale_price:
        return 'kkadaegi', f'정가 {normal_price:,.0f} ≤ 고객 결제액 {order.sale_price:,.0f}'
    return 'direct', f'정가 {normal_price:,.0f} > 고객 결제액 {order.sale_price:,.0f}'


def shipping_fee_for(order: OrderRef, order_type: str) -> float:
    """삼바웨이브에 기록할 배송비 — 포이즌 외 마켓의 까대기 건만 2,300원, 나머지(포이즌·직배)는 0."""
    if order_type == 'kkadaegi' and not is_poison_seller(order.seller):
        return float(KKADAEGI_SHIPPING_FEE)
    return 0.0


def matching_options(options: list[str], wanted: str | None) -> list[str]:
    """주문 옵션과 맞는 후보들. 주문 옵션이 없으면 전부 후보다.

    순서: 정확 일치 → 정규화 일치 → 후보가 주문 옵션(정규화)을 포함하거나 그 반대 →
    숫자만 같은 것(사이즈 230 ↔ '230(mm)'). '품절' 표시가 붙은 후보는 뺀다.
    아무 단계도 안 맞으면 빈 목록 — 절대 '가까운 값' 으로 대신하지 않는다.
    """
    live = [o for o in options if not _sold_out(o)]
    if not wanted:
        return live
    w = wanted.strip()
    exact = [o for o in live if o.strip() == w]
    if exact:
        return exact
    nw = _norm(w)
    if nw:
        normed = [o for o in live if _norm(o) == nw]
        if normed:
            return normed
        contains = [o for o in live if _norm(o) and (nw in _norm(o) or _norm(o) in nw)]
        if contains:
            return contains
        # 주문 옵션이 "카키 085(L) NP6KP12C" 처럼 여러 단계·품번이 섞인 경우 — 토큰 하나가 후보 안에 있으면 맞는 것으로
        # 본다(실기: 롯데온 사이즈 "085(L) 35,100 2개 남음 (품절임박)"). 한 글자짜리 토큰(M·L)은 너무 헐거워 뺀다
        for tok in w.split():
            nt = _norm(tok)
            if len(nt) < 2:
                continue
            # 경계 일치가 먼저 — "XL" 은 "Black-XL" 에만 맞고 "Black-XXL"·"Black-XLT" 에는 안 맞는다
            by_piece = [o for o in live if nt in [_norm(x) for x in re.split(r'[-\s/]+', o)]]
            if by_piece:
                return by_piece
            by_tok = [o for o in live if nt in _norm(o)]
            if by_tok:
                return by_tok
    digits = re.findall(r'\d+', w)
    if len(digits) == 1:
        by_digit = [o for o in live if re.findall(r'\d+', o) == digits]
        if by_digit:
            return by_digit
    return []


# 품절 표시: "[품절]"·끝의 "품절"·"(품절)". "품절임박"(재고 적음)은 품절이 아니다(실기: 롯데온)
_SOLD_OUT_RE = re.compile(r'\[품절\]|품절(?!임박)')


def _sold_out(option: str) -> bool:
    return _SOLD_OUT_RE.search(option) is not None


def snapshot_args(agent_name: str, order: OrderRef, account: str | None = None) -> str:
    """run_script 에 넘길 JSON 문자열. 옵션이 있으면 size 로, 계정이 있으면 account 로 같이 준다.

    account 를 주면 주문의 계정 대신 그 계정으로 돈다(계정 비교 중 각 계정의 견적).
    """
    args: dict[str, object] = {'sku': product_ref(agent_name, order), 'qty': order.qty}
    if order.option:
        args['size'] = order.option
    account = account or order.account
    if account:
        # 계정별 탭 프로필 — 세션(쿠키)이 계정마다 따로라 다른 계정으로 로그인된 채 사는 일이 없다
        args['account'] = account
        args['profile'] = account
    return json.dumps(args, ensure_ascii=False)


def _int_ids(values: list[object]) -> list[int]:
    """요소 번호 목록 — 정수 또는 숫자 문자열만 남긴다."""
    out: list[int] = []
    for v in values:
        if isinstance(v, bool):
            continue
        if isinstance(v, int):
            out.append(v)
        elif isinstance(v, str) and v.strip().isdigit():
            out.append(int(v.strip()))
    return out


def _as_float(value: object) -> float:
    """스냅샷 금액 → float. 비었거나 숫자가 아니면 0(모름)."""
    try:
        return float(value or 0)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


def parse_account_labels(raw: str) -> tuple[list[str], bool]:
    """앱 list_accounts 결과 → (계정 라벨 목록, 금고 잠김 여부).

    앱은 풀린 금고면 계정 배열을, 잠겼으면 {"vaultLocked": true, "accounts": [...]} 를,
    그 밖(호스트 모름·금고 미설정)은 {"accounts": [], "note": ...} 나 안내 문자열을 준다
    (src/main/agent/tools.ts list_accounts). 라벨은 우리 사이트에서 로그인 아이디와 같다.
    """
    body, _ = split_page_dialogs(raw)
    try:
        parsed = json.loads(body)
    except ValueError:
        return [], False
    locked = False
    items: object = parsed
    if isinstance(parsed, dict):
        locked = bool(parsed.get('vaultLocked'))
        items = parsed.get('accounts') or []
    labels: list[str] = []
    if isinstance(items, list):
        for item in items:
            label = str(item.get('label') or '').strip() if isinstance(item, dict) else ''
            if label and label not in labels:
                labels.append(label)
    return labels, locked


# 로그인 확인은 소싱처 첫 페이지(sources.yaml 의 home)에서 시작한다. 앱의 login 도구는 폼이 없으면
# 이미 로그인됐는지 보고, 아니면 알려진 로그인 URL(shared/site-rules)로 스스로 옮겨 간다 —
# 여기서 로그인 URL 을 알 필요가 없다
# 앱 login 도구의 결과 문자열 머리(src/main/agent/tools.ts)
ALREADY_SIGNED_IN = 'already signed in'
LOGIN_SUBMITTED = 'submitted'
# 페이지 이동·로그인 제출 뒤 화면이 안정되길 기다리는 시간
_LOGIN_SETTLE_MS = 2500
# 같은 소싱처에서 다른 계정으로 로그인을 이어 갈 때의 최소 간격(초). 연달아 바꾸면 사이트가 차단한다(실기: SSG)
_ACCOUNT_SWITCH_GAP_S = 60.0


# 주문의 배송지를 앱에서 실행 시점에 읽어오는 전역 스크립트(소싱처 무관 — 주문 관리 쪽 데이터)
SHIPPING_SCRIPT = 'samba_order_shipping'

# 되읽어 대조하는 배송지 필드 — 전부 개인정보라 어디에도 원문을 남기지 않는다.
# 전화는 하네스가 아예 다루지 않는다(앱이 키마스터 신원정보로 채운다)
SHIPPING_FIELDS = ('name', 'address')

# 배송지 스크립트에 넘기는 키. phone 키는 어떤 출처에서 와도 넣지 않는다 — 고객 전화번호는
# 어디에도 입력하지 않는다(사용자 결정 2026-09-23)
SHIPPING_ARG_FIELDS = ('name', 'address', 'address_detail', 'postal_code')

# 배송 연락처 — 앱 fill_secret 이 키마스터 신원정보의 이 필드로 전화 칸을 채운다
PHONE_SECRET_ITEM = 'identity'
PHONE_SECRET_FIELD = 'identity.phone'

# 까대기 주문서에서 기본 배송지가 채워졌는지 get_page 로 볼 때 쓰는 표시.
# 수령인 라벨이 있고 '배송지 없음' 류 문구가 없으면 채워진 것으로 본다
RECIPIENT_MARKERS = ('받는 분', '받는분', '받으시는 분', '수령인', '수취인')
EMPTY_SHIPPING_MARKERS = (
    '배송지를 입력',
    '배송지를 등록',
    '배송지를 추가',
    '등록된 배송지가 없',
    '배송지가 없습니다',
)

# dry_run 이면 구매 에이전트가 절대 부르지 않는 부수효과 도구(허용 목록에 있어도 막는다)
DRY_RUN_BLOCKED_TOOLS = frozenset(
    {
        'save_script',
        'update_playbook',
        'remember_site',
        'phone_approve_payment',
        'phone_tap',
        'phone_type',
        'phone_key',
        'phone_swipe',
    }
)


class BuyerAgent(AgentBase):
    """등록부의 buyer.* 한 행에 대응한다."""

    _dry_run: bool = True
    # 배송지 공급자(삼바웨이브 상세). 없으면 스냅샷·전용 스크립트로 받는다
    _shipping_fn: 'ShippingFn | None' = None
    # 계정 비교 상한(SAMBA_COMPARE_ACCOUNTS_MAX). 배선은 factory 가 한다
    compare_accounts_max: int = 3
    # (계정, 시각) — 같은 사이트에서 마지막으로 로그인한 계정
    _last_login: tuple[str, float] | None = None
    _order_type_noted: tuple[str, str] | None = None

    def __call__(self, assignment: Assignment) -> AgentResult:
        self._dry_run = assignment.dry_run
        # 계정 비교 중 견적이 실패한 사유들(모든 계정 실패 때 결과 판정에 쓴다)
        self._quote_errors: list[AgentFailure] = []
        return run_agent(lambda: self._buy(assignment), lambda: self.evidence)

    def tool(self, name: str, /, **args: object) -> str:
        """dry_run 이면 부수효과 도구는 허용 목록에 있어도 아예 부르지 않는다(불변조건)."""
        if self._dry_run and name in DRY_RUN_BLOCKED_TOOLS:
            raise AgentFailure(
                'fail',
                f'dry_run 에서는 부수효과 도구를 부르지 않는다: {name}',
                FailReason.PERMISSION_DENIED,
            )
        return super().tool(name, **args)

    def _home(self) -> str:
        """소싱처 첫 페이지 — 로그인 확인·계정 목록 조회를 여기서 시작한다."""
        home = source_of(self.spec.name).home
        if not home:
            raise AgentFailure(
                'needs_human',
                f'소싱처 첫 페이지 주소가 표에 없다: {self.spec.name}',
                FailReason.UNKNOWN,
            )
        return home

    def _login_as(self, account: str) -> None:
        """그 소싱 계정으로 로그인돼 있게 한다(실기: 로그인 안 된 채 스냅샷 → 주문서 대신 로그인 페이지).

        앱 login 도구는 이미 로그인돼 있으면 누구인지까지는 말해 주지 않는다 — 계정 일치는
        스냅샷의 account 로 한 번 더 본다(_check_account).
        """
        home = self._home()
        self.step(f'{self.spec.name}: 로그인 확인({account})')
        # 같은 사이트에서 직전에 다른 계정으로 로그인했으면 간격을 둔다(연달아 바꾸면 차단)
        last = self._last_login
        # 프로필 탭으로 계정을 나누는 소싱처(buy_accounts)는 로그아웃·재로그인이 없어 간격이 필요 없다
        if last is not None and last[0] != account and not source_of(self.spec.name).buy_accounts:
            gap = _ACCOUNT_SWITCH_GAP_S - (time.monotonic() - last[1])
            if gap > 0:
                self.note('계정 전환', f'차단 방지 대기 {int(gap)}초')
                self.tool('wait', ms=int(gap * 1000))
        self._last_login = (account, time.monotonic())
        # 계정 이름의 프로필로 탭을 연다 — 저장 스크립트도 같은 profile 인자를 받아 그 세션에서 돈다
        self.tool('new_tab', url=home, profile=account)
        self.tool('wait', ms=_LOGIN_SETTLE_MS)
        out = self.tool('login', accountLabel=account).strip()
        if out.startswith(ALREADY_SIGNED_IN):
            self.note('로그인', '이미 로그인돼 있음')
            return
        if out.startswith(LOGIN_SUBMITTED):
            self.tool('wait', ms=_LOGIN_SETTLE_MS)
            out = self.tool('login', accountLabel=account).strip()
            if out.startswith(ALREADY_SIGNED_IN):
                self.note('로그인', f'{account} 로 로그인 완료')
                return
        raise AgentFailure(
            'needs_human',
            f'로그인 실패({account}): {mask_text(out[:120])}',
            FailReason.PERMISSION_DENIED,
        )

    def _candidate_accounts(self, a: Assignment) -> list[str]:
        """구매 후보 계정. 주문이 계정을 지정하면 그 계정 하나(비교하지 않는다).

        지정이 없으면 기본 프로필로 소싱처 첫 페이지를 열고 키마스터의 그 사이트 계정 목록을 받는다
        (앱 list_accounts 는 현재 탭 호스트의 계정만 답한다). 비교 비용 때문에 앞에서부터
        최대 compare_accounts_max 개만 쓴다.
        """
        source = source_of(self.spec.name)
        if source.buy_accounts:
            # 플레이북이 계정을 정해 둔 소싱처 — SAMBA 주문계정은 기록용일 뿐 구매 계정이 아니다(§5)
            self.note('계정 후보', f'{source.id}: 플레이북 지정 계정 {source.buy_accounts}')
            return list(source.buy_accounts)
        if a.order.account:
            # 비교 계정을 정해 두지 않은 소싱처는 주문이 지정한 계정으로 산다
            return [a.order.account]
        if not source.compare_accounts:
            # 계정 전환이 차단을 부르는 사이트 — 첫 계정 하나로만 산다
            labels, locked = self._first_account(source)
            self.note('계정 후보', f'{source.id}: 계정 비교 없음(전환 차단 방지) — {labels[0]}')
            return labels[:1]
        home = self._home()
        host = source.login_host or urlparse(home).hostname or ''
        self.step(f'{self.spec.name}: 계정 목록 확인')
        self.tool('new_tab', url=home)
        self.tool('wait', ms=_LOGIN_SETTLE_MS)
        labels, locked = parse_account_labels(self.tool('list_accounts', host=host))
        if locked or not labels:
            raise AgentFailure(
                'needs_human',
                f'소싱처 계정 없음/금고 잠김: {source.id}',
                FailReason.PERMISSION_DENIED,
            )
        cap = self.compare_accounts_max
        if len(labels) > cap:
            self.note(
                '계정 후보', f'{len(labels)}개 중 앞 {cap}개만 비교(SAMBA_COMPARE_ACCOUNTS_MAX)'
            )
            labels = labels[:cap]
        return labels

    def _with_payable_accounts(self, source: Source, first: str) -> list[str]:
        """주문 계정 + 키마스터 결제 항목(payments)이 있는 같은 사이트 계정들(상한 compare_accounts_max).

        목록을 못 읽으면 주문 계정 하나로 간다.
        """
        home = self._home()
        host = source.login_host or urlparse(home).hostname or ''
        self.step(f'{self.spec.name}: 계정 목록 확인')
        self.tool('new_tab', url=home)
        self.tool('wait', ms=_LOGIN_SETTLE_MS)
        raw = self.tool('list_accounts', host=host)
        labels, _locked = parse_account_labels(raw)
        out = [first]
        for label in labels:
            if label == first or len(out) >= self.compare_accounts_max:
                continue
            payments = parse_account_payments(raw, label)
            if payments:
                out.append(label)
        if len(out) > 1:
            self.note('계정 후보', f'주문 계정 {first} + 결제 항목 있는 {out[1:]} 비교')
        return out

    def _first_account(self, source: Source) -> tuple[list[str], bool]:
        home = self._home()
        host = source.login_host or urlparse(home).hostname or ''
        self.tool('new_tab', url=home)
        self.tool('wait', ms=_LOGIN_SETTLE_MS)
        labels, locked = parse_account_labels(self.tool('list_accounts', host=host))
        if locked or not labels:
            raise AgentFailure(
                'needs_human',
                f'소싱처 계정 없음/금고 잠김: {source.id}',
                FailReason.PERMISSION_DENIED,
            )
        return labels, locked

    def _snapshot(self, a: Assignment, account: str) -> dict[str, object]:
        """그 계정의 탭 프로필에서 상품 스냅샷(주문서까지)을 만든다.

        소싱처가 payment_quotes 면 주문서에서 결제수단별 금액까지 읽어 가장 싼 수단을 스냅샷에 싣는다
        (cost 를 그 금액으로 바꾸고 pay_method·pay_card 를 붙인다) — 계정 비교도 이 금액으로 한다.
        """
        self.step(f'{self.spec.name}: 상품 확인({account})')
        snap = self.json_tool(
            'run_script',
            name=source_of(self.spec.name).snapshot_script,
            args=snapshot_args(self.spec.name, a.order, account=account),
        )
        if snap.get('already_ordered') or snap.get('existing_order_no'):
            return snap  # 중복 구매 흔적 — 정돈·견적 없이 호출부가 바로 거절한다
        if source_of(self.spec.name).order_prep and _as_float(snap.get('cost')) > 0:
            self._order_prep(account, snap)
        # 결제수단 견적은 계정을 고른 뒤 한 번만(_buy) — 계정 비교 중에는 쿠폰 반영 총액만 본다
        if source_of(self.spec.name).normal_price and snap.get('normal_price') is None:
            self._apply_normal_price(a, account, snap)
        return snap

    def _apply_normal_price(self, a: Assignment, account: str, snap: dict[str, object]) -> None:
        """소싱처 정가(`<key>_normal_price`)를 스냅샷에 싣는다. 못 읽으면 None 으로 두고 근거만 남긴다."""
        try:
            out = self.json_tool(
                'run_script',
                name=source_of(self.spec.name).normal_price_script,
                args=json.dumps(
                    {'sku': product_ref(self.spec.name, a.order), 'profile': account}, ensure_ascii=False
                ),
            )
        except AgentFailure as e:
            self.note('정가', mask_text(f'못 읽음({e.reason[:80]})'))
            return
        price = _as_float(out.get('normal_price'))
        if price > 0:
            snap['normal_price'] = price
            self.note('정가', f'{price:,.0f}원')

    def _order_prep(self, account: str, snap: dict[str, object]) -> None:
        """주문서 정돈(`<key>_order_prep`): 적립금 규칙(5만 미만 0원·이상 최대)·선할인. 규칙대로 못 맞추면 사람에게."""
        self.step(f'{self.spec.name}: 주문서 정돈({account})')
        out = self.json_tool(
            'run_script',
            name=source_of(self.spec.name).order_prep_script,
            args=json.dumps({'profile': account}, ensure_ascii=False),
        )
        if not out.get('ok'):
            raise AgentFailure(
                'needs_human',
                f'주문서 정돈 실패: {mask_text(str(out.get("note") or "")[:80])}',
                FailReason.UNKNOWN,
            )
        used = _as_float(out.get('points_used'))
        snap['points_used'] = used
        total = _as_float(out.get('total'))
        if total > 0:
            # 쿠폰·장바구니 쿠폰·선할인이 반영된 총 결제 금액 — 계정 비교와 원가의 출발점
            snap['cost'] = total
            snap['pay_amount'] = total
        self.note(
            '쿠폰',
            f"상품 쿠폰 {_as_float(out.get('coupon')):,.0f}원 · 장바구니 쿠폰 {_as_float(out.get('cart_coupon')):,.0f}원 → 총 {total:,.0f}원",
        )
        self.note(
            '주문서 정돈',
            f"보유 적립금 {_as_float(out.get('points_balance')):,.0f}원 → 사용 {used:,.0f}원, 선할인 {out.get('prepay')}",
        )

    def _payable_providers(self, account: str) -> set[str] | None:
        """이 계정으로 실제 낼 수 있는 결제 제공자(키마스터에 결제 비밀번호·카드가 있는 것).

        앱 list_accounts 의 payments(결제 제공자)·types('card') 로 판단한다. 목록을 못 읽으면 None —
        그때는 걸러내지 않고 스냅샷 원가로 간다(견적을 잘못 거르는 것보다 안 거르는 게 안전).
        """
        home = self._home()
        host = source_of(self.spec.name).login_host or urlparse(home).hostname or ''
        try:
            raw = self.tool('list_accounts', host=host)
        except AgentFailure:
            return None
        return parse_account_payments(raw, account)

    def _apply_payment_quotes(self, a: Assignment, account: str, snap: dict[str, object]) -> None:
        """주문서의 결제수단별 견적(`<key>_payment_quotes`)에서 결제 가능한 가장 싼 조합을 스냅샷에 반영한다.

        요청자가 카드를 지정했으면 그 수단·카드사만 후보다. 견적을 못 읽으면(스크립트 실패·빈 목록)
        스냅샷 원가 그대로 간다 — 견적은 더 싸게 사기 위한 것이지 구매 조건이 아니다.
        """
        # 주문서 결제수단 중 우리가 낼 수 있는 종류(간편결제·사이트 머니)가 하나도 없으면 견적할 것이 없다
        offered = [str(m) for m in (snap.get('methods') or [])]
        if not any(quote_provider(m) for m in offered):
            self.note('결제수단 견적', f'견적할 수단 없음(주문서 {offered}) — 스냅샷 원가로 진행')
            return
        # 결제 가능한 수단을 먼저 정한다 — 그 수단만 시험한다(카드사 12개를 전부 돌리는 낭비·화면 소란 방지)
        payable = self._payable_providers(account)
        if payable is None:
            # 결제 가능 여부를 모르면 견적으로 수단을 바꾸지 않는다 — 계좌이체처럼 낼 수 없는 수단을 고를 수 있다
            self.note('결제수단 견적', '키마스터 결제 항목을 못 읽어 견적을 돌리지 않는다 — 스냅샷 원가로 진행')
            return
        if not payable:
            # 이 계정엔 키마스터 결제 항목이 하나도 없다 — 견적을 돌리지 않고 스냅샷 기본 수단으로 간다.
            # 실결제 때 결제 에이전트가 항목 없음으로 멈추고, 승인 카드 근거에 이 사실이 남는다
            self.note('결제수단 견적', f'{account} 에 키마스터 결제 항목 없음 — 견적 미실행, 스냅샷 원가로 진행')
            return
        methods = payable_methods(offered, payable)
        if not methods:
            self.note('결제수단 견적', f'주문서 결제수단 중 결제 가능한 것 없음(가능 {sorted(payable)}) — 스냅샷 원가로 진행')
            return
        self.step(f'{self.spec.name}: 결제수단 견적({account})')
        try:
            out = self.json_tool(
                'run_script',
                name=source_of(self.spec.name).payment_quotes_script,
                args=json.dumps({'profile': account, 'methods': methods}, ensure_ascii=False),
            )
        except AgentFailure as e:
            self.note('결제수단 견적', mask_text(f'못 읽음({e.reason[:80]}) — 스냅샷 원가로 진행'))
            return
        raw_quotes = out.get('quotes')
        if not isinstance(raw_quotes, list) or not raw_quotes:
            self.note('결제수단 견적', '견적 없음 — 스냅샷 원가로 진행')
            return
        quotes = cheapest_quotes(raw_quotes, a.options.get('card'), payable)
        if not quotes:
            # 결제 항목은 있는데 이 주문서의 수단과 겹치지 않는다 — 모델이 고르게 두면 실결제에서 어차피 막힌다
            offered = sorted({str(q.get('method')) for q in raw_quotes if isinstance(q, dict)})
            raise AgentFailure(
                'needs_human',
                f'결제 가능한 수단이 없다({account}): 키마스터 결제 항목 {sorted(payable) or "없음"}, '
                f'주문서 결제수단 {offered}',
                FailReason.CARD_MISSING,
            )
        best = quotes[0]
        snap['cost'] = best['cost']
        snap['pay_amount'] = best['paid']
        snap['pay_method'] = best['method']
        snap['pay_card'] = best['card']
        label = f"{best['method']}/{best['card']}" if best['card'] else best['method']
        payable_note = '' if payable is None else f', 결제 가능 {sorted(payable)}'
        self.note(
            '결제수단 견적',
            f"{label} {best['cost']:,.0f}원 — 최저 (후보 {len(quotes)}건, 기본 "
            f"{_as_float(out.get('base_cost')):,.0f}원{payable_note})",
        )

    def _quote(self, a: Assignment, account: str) -> dict[str, object] | None:
        """한 계정의 견적 — 로그인·주문서까지 만들어 원가를 읽는다. 살 수 없으면 None.

        같은 상품을 이미 산 흔적은 계정과 무관한 중단 사유라 그대로 던진다. 그 밖의 실패
        (로그인 실패·품절·원가 없음)는 이 계정만 빼고 근거에 남긴다 — 원문 개인정보는 남기지 않는다.
        """
        try:
            self._login_as(account)
            snap = self._snapshot(a, account)
            self._check_account(account, snap)
        except AgentFailure as e:
            if e.fail_reason is FailReason.DUPLICATE:
                raise
            self._quote_errors.append(e)
            self.note('계정 견적', mask_text(f'{account}: 불가({e.reason[:80]})'))
            return None
        if snap.get('already_ordered') or snap.get('existing_order_no'):
            raise AgentFailure(
                'fail', f'이미 구매한 흔적이 있다: {a.order.sku}', FailReason.DUPLICATE
            )
        options = [str(o) for o in (snap.get('options') or [])]
        if not matching_options(options, a.order.option):
            self.note('계정 견적', mask_text(f'{account}: 불가(주문 옵션 품절)'))
            return None
        cost = _as_float(snap.get('cost'))
        if cost <= 0:
            self.note('계정 견적', mask_text(f'{account}: 불가(원가를 읽지 못함)'))
            return None
        self.note('계정 견적', mask_text(f'{account}: 원가 {cost:,.0f}원'))
        return {**snap, 'cost': cost}

    def _pick_cheapest(self, a: Assignment, accounts: list[str]) -> tuple[str, dict[str, object]]:
        """계정마다 견적을 내고 원가가 가장 낮은 계정(같으면 앞 계정)과 그 스냅샷을 고른다.

        스크립트는 가장 최근 주문서 탭을 읽으므로, 이긴 계정이 마지막으로 연 계정이 아니면
        다시 로그인·스냅샷해서 그 주문서를 최신 탭으로 만든다.
        """
        self._quote_errors = []
        quotes: list[tuple[str, dict[str, object]]] = []
        for account in accounts:
            q = self._quote(a, account)
            if q is not None:
                quotes.append((account, q))
        if not quotes:
            # 어느 계정도 스냅샷까지 못 갔고 전부 사람 확인(로그인 실패·캡차)이면 그 사유가 맞다 — 품절이 아니다
            errors = self._quote_errors
            if len(errors) == len(accounts) and all(e.status == 'needs_human' for e in errors):
                first = errors[0]
                raise AgentFailure(
                    'needs_human', f'모든 계정 불가 — {first.reason}', first.fail_reason
                )
            raise AgentFailure(
                'fail',
                mask_text(f'모든 계정에서 살 수 없다(품절·실패): {", ".join(accounts)}'),
                FailReason.OUT_OF_STOCK,
            )
        # min 은 같은 값이면 앞 것을 준다 — 동률이면 먼저 비교한 계정
        winner, snap = min(quotes, key=lambda q: _as_float(q[1].get('cost')))
        cost = _as_float(snap.get('cost'))
        self.note('계정 선택', f'{winner} — 원가 최저 {cost:,.0f}원 (비교 {len(accounts)}계정)')
        if winner != accounts[-1]:
            self._login_as(winner)
            snap = self._snapshot(a, winner)
        return winner, snap

    def _check_account(self, want: str, snap: dict[str, object]) -> None:
        """스냅샷이 로그인 계정을 알려 주면 고른 소싱 계정과 대조한다. 다르면 사람에게 넘긴다.

        실기: 사이트가 아이디 대신 표시 이름(한글 별명 '김사무1')을 돌려주는 곳이 있다 —
        아이디끼리 비교할 때만 불일치로 본다. 표시 이름이면 대조를 못 했다고 남기고 지나간다.
        """
        seen = str(snap.get('account') or '').strip()
        if not (want and seen):
            return
        if want.lower() in seen.lower():
            return
        if not _LOGIN_ID.fullmatch(seen):
            self.note('로그인 계정', f'표시 이름이라 대조 불가: {seen} (주문 계정 {want})')
            return
        raise AgentFailure(
            'needs_human',
            f'다른 계정으로 로그인돼 있다: {seen} (주문 계정 {want})',
            FailReason.PERMISSION_DENIED,
        )

    def _buy(self, a: Assignment) -> AgentResult:
        self.evidence = []
        # 계정 비교(사용자 지시 2026-09-23) — 주문 지정 계정이 없으면 키마스터 계정마다 주문서까지
        # 만들어 원가를 비교하고 가장 싼 계정으로 산다
        accounts = self._candidate_accounts(a)
        if len(accounts) == 1:
            account = accounts[0]
            self._login_as(account)
            snap = self._snapshot(a, account)
            why = '주문 지정 계정' if a.order.account else '키마스터의 유일한 계정'
            self.note('계정 선택', f'{account} — {why}')
        else:
            account, snap = self._pick_cheapest(a, accounts)

        self._check_account(account, snap)
        if (
            source_of(self.spec.name).payment_quotes
            and _as_float(snap.get('cost')) > 0
            and not snap.get('already_ordered')
            and not snap.get('existing_order_no')
        ):
            self._apply_payment_quotes(a, account, snap)
        # 같은 상품을 이미 산 흔적 — 옵션 선택 전에 끝낸다(규칙 파일 §3)
        if snap.get('already_ordered') or snap.get('existing_order_no'):
            raise AgentFailure(
                'fail', f'이미 구매한 흔적이 있다: {a.order.sku}', FailReason.DUPLICATE
            )

        options = [str(o) for o in (snap.get('options') or [])]
        if not options:
            raise AgentFailure('fail', f'옵션이 없다(품절): {a.order.sku}', FailReason.OUT_OF_STOCK)
        self.note('옵션 목록', ', '.join(options))

        # 주문 옵션과 맞는 후보만 남긴다 — 모델이 "가장 가까운 220" 을 골라 230 주문에 220 을 넣을 뻔했다(실기).
        # 맞는 후보가 없으면 품절, 하나면 그대로, 여럿이면 그 안에서만 모델이 고른다
        candidates = matching_options(options, a.order.option)
        if not candidates:
            raise AgentFailure(
                'fail',
                f'주문 옵션 [{a.order.option}] 에 맞는 후보가 없다(품절): {options}',
                FailReason.OUT_OF_STOCK,
            )
        if len(candidates) == 1:
            picked = Decision(
                choice=candidates[0], reason=f'주문 옵션 [{a.order.option}] 과 일치하는 후보가 하나'
            )
        else:
            picked = self.decide_once(
                f'{a.rules}\n\n주문 {a.order.order_no} 의 SKU {a.order.sku} 에 맞는 옵션을 고르라.\n'
                f'후보(주문 옵션과 맞는 것만): {candidates}',
                Decision,
            )
        if picked.choice not in candidates:
            raise AgentFailure(
                'fail', f'고른 옵션이 후보에 없다: {picked.choice}', FailReason.OUT_OF_STOCK
            )
        self.note('옵션 선택', f'{picked.choice} — {picked.reason}')

        # 배송지 — 개인정보(이름·주소)라 Assignment/state/payload 에는 절대 담지 않는다.
        # 실행 시점에만 받아 입력 도구 호출에 바로 쓰고 로컬 변수 밖으로 내보내지 않는다.
        self._set_shipping(a, snap, account)

        # 결제수단·카드 — 지시받은 카드가 목록에 없으면 여기서 거절한다
        methods = [str(m) for m in (snap.get('methods') or [])]
        card = a.options.get('card')
        quoted = snap.get('pay_method')
        card_issuer: str | None = None
        if quoted:
            # 결제수단 견적이 고른 조합 — 수단 이름은 card(결제창 진입용), 카드사는 card_issuer(결제 앱 안에서 고름)
            card = str(quoted)
            card_issuer = str(snap.get('pay_card') or '') or None
            self.note('수단 선택', f'{card}{"/" + card_issuer if card_issuer else ""} — 결제수단 견적 최저')
        elif card and card not in methods:
            raise AgentFailure(
                'fail', f'지시받은 카드가 결제수단에 없다: {card}', FailReason.CARD_MISSING
            )
        if quoted:
            pass
        elif not card:
            chosen = self.decide_once(
                f'{a.rules}\n\n결제수단 후보 {methods} 중 원가 규칙에 가장 맞는 것을 고르라.',
                Decision,
            )
            if chosen.choice not in methods:
                raise AgentFailure(
                    'fail', f'고른 수단이 목록에 없다: {chosen.choice}', FailReason.CARD_MISSING
                )
            card = chosen.choice
            self.note('수단 선택', f'{card} — {chosen.reason}')
        else:
            self.note('수단 선택', f'{card} — 요청자가 지정')

        cost = _as_float(snap.get('cost'))
        # 실제 결제액(적립·배송비 보정 전) — 스냅샷이 주면 기록 메모에 싣는다. 0 이면 모름
        paid = float(snap.get('pay_amount') or 0)
        margin = self._margin(a.order, cost, float(snap.get('margin_pct') or 0))
        self.step(f'{self.spec.name}: 결제 직전까지 준비 완료')
        return AgentResult(
            status='ok',
            reason=(
                f'옵션 {picked.choice}({picked.reason}), 계정 {account}, 배송지 반영, '
                f'카드 {card}, 원가 {cost:,.0f}원, 마진 {margin}%'
            ),
            payload={
                'option': picked.choice,
                'account': account,
                'accounts_compared': len(accounts),
                'shipping_set': True,
                'order_type': self.order_type_of(a.order, snap),
                'shipping_fee': shipping_fee_for(a.order, self.order_type_of(a.order, snap)),
                'card': card,
                **({'card_issuer': card_issuer} if card_issuer else {}),
                'cost': cost,
                'margin_pct': margin,
                **({'paid': paid} if paid > 0 else {}),
            },
            evidence=tuple(self.evidence),
        )

    def _margin(self, order: OrderRef, cost: float, snap_margin: float) -> float:
        """마진율(플레이북 §3) = (SAMBA 정산금 − 원가) ÷ SAMBA 매출 × 100.

        스냅샷은 우리 판매가를 모른다 — 정산금이 있으면 늘 그것으로 계산한다. 정산금을 모르면
        스냅샷 값이 없을 때만 판매가 기준 근사치 (판매가 − 원가) ÷ 판매가 를 쓰고 근거에 남긴다.
        """
        sale = order.sale_price
        if cost <= 0 or sale <= 0:
            return snap_margin
        if order.revenue > 0:
            margin = round((order.revenue - cost) / sale * 100, 1)
            self.note(
                '마진 계산',
                f'(정산금 {order.revenue:,.0f} - 원가 {cost:,.0f}) ÷ 매출 {sale:,.0f} → {margin}%',
            )
            return margin
        if snap_margin > 0:
            return snap_margin
        margin = round((sale - cost) / sale * 100, 1)
        self.note(
            '마진 계산',
            f'판매가 {sale:,.0f} - 원가 {cost:,.0f} → {margin}% (정산금 미확인 근사)',
        )
        return margin

    def set_shipping_provider(self, provider: ShippingFn | None) -> None:
        """배송지 공급자(삼바웨이브 상세)를 꽂는다. 배선은 factory 가 한다.

        직배·선물 주문의 고객 이름·주소를 앱 화면을 거치지 않고 받는다. 까대기는 계정 기본
        배송지(사무실)를 유지하므로 공급자를 부르지 않는다(플레이북 §4).
        """
        self._shipping_fn = provider

    def order_type_of(self, order: OrderRef, snap: dict[str, object] | None = None) -> str:
        """이 주문의 배송 종류(decide_order_type). 정할 수 없으면 사람에게 넘긴다.

        삼바웨이브 태그는 이 판정의 **결과**로 기록되는 값이지 입력이 아니다(사용자 설명 2026-09-24).
        """
        source = source_of(self.spec.name)
        forced = source.order_type
        if not source.normal_price and not forced and not is_poison_seller(order.seller):
            # 정가 스크립트가 없는 소싱처는 아직 자동 판정을 못 한다 — 삼바웨이브 태그(order_type)를 따른다
            return order.order_type
        normal = _as_float(snap.get('normal_price')) if snap else 0.0
        kind, why = decide_order_type(order, normal if normal > 0 else None, forced)
        if not kind:
            raise AgentFailure('needs_human', f'직배/까대기 판정 불가 — {why}', FailReason.UNKNOWN)
        if self._order_type_noted != (order.order_no, kind):
            self._order_type_noted = (order.order_no, kind)
            self.note('배송 종류', f'{"까대기" if kind == "kkadaegi" else "선물" if kind == "gift" else "직배"} — {why}')
        return kind

    def _fetch_shipping(self, a: Assignment, snap: dict[str, object]) -> dict[str, object]:
        """배송지 출처 — 삼바웨이브(공급자) > 스냅샷에 실려 온 값 > 전용 스크립트 순.

        어느 경로든 받은 값은 이 호출 안에서만 살아 있다(호출부가 바로 입력하고 버린다).
        """
        if self._shipping_fn is not None:
            try:
                fetched = self._shipping_fn(a.order.order_no, self.order_type_of(a.order, snap))
            except WaveError as e:
                raise AgentFailure('fail', f'배송지 조회 실패: {e}', e.reason) from e
            if fetched:
                return fetched
        embedded = snap.get('shipping')
        if isinstance(embedded, dict) and embedded:
            return embedded
        fetched = self.json_tool(
            'run_script', name=SHIPPING_SCRIPT, args=f'{{"order_no":"{a.order.order_no}"}}'
        )
        shipping = fetched.get('shipping')
        return shipping if isinstance(shipping, dict) else fetched

    def _set_shipping(self, a: Assignment, snap: dict[str, object], account: str) -> None:
        """배송지 — 까대기면 기본 배송지를 유지하고, 직배·선물이면 고객 이름·주소를 새로 넣는다.

        원문은 이 함수 밖으로 나가지 않는다 — self.note 에는 마스킹된 요약만 남긴다.
        """
        if self.order_type_of(a.order, snap) == 'kkadaegi':
            if self._keep_default_shipping(snap):
                return
            # 기본 배송지가 사무실이 아니다(또는 없다) — 목록에 사무실 배송지가 있으면 그것을 고르고,
            # 없을 때만 사무실 주소를 새로 넣는다. 기본 배송지 자체는 바꾸지 않는다(poizon-sourcing 스킬 "사무실 배송")
            if self._select_existing_shipping(dict(OFFICE_SHIPPING), account):
                return
            self.note('배송지', '목록에 사무실 배송지가 없어 사무실 주소를 새로 넣는다')
            self._apply_shipping(a, dict(OFFICE_SHIPPING), account)
            return

        self._apply_shipping(a, self._fetch_shipping(a, snap), account)

    def _select_existing_shipping(self, shipping: dict[str, object], account: str) -> bool:
        """배송지 목록에서 이미 있는 항목(이름·주소)을 골라 주문서에 반영한다(`<key>_select_shipping`).

        스크립트가 없거나 목록에 없으면 False — 호출부가 신규 입력으로 넘어간다. 실기: 사무실 주소가 이미 있는데
        새 배송지를 만들고 나서 기존 것을 고르던 낭비(사용자 지적 2026-09-24).
        """
        source = source_of(self.spec.name)
        args = {'name': shipping.get('name'), 'address': shipping.get('address')}
        if account:
            args['profile'] = account
        try:
            out = self.json_tool(
                'run_script', name=f'{source.key}_select_shipping', args=json.dumps(args, ensure_ascii=False)
            )
        except AgentFailure as e:
            self.note('배송지', mask_text(f'기존 항목 선택 불가({e.reason[:60]}) — 신규 입력으로'))
            return False
        if not out.get('ok') or not shipping_matches(shipping, out):
            self.note('배송지', mask_text(f'기존 항목 선택 실패({str(out.get("note") or "")[:60]}) — 신규 입력으로'))
            return False
        self.note('배송지', '목록의 사무실 배송지를 골라 주문서에 반영')
        return True

    def _apply_shipping(self, a: Assignment, shipping: dict[str, object], account: str) -> None:
        """이름·주소를 배송지 스크립트로 넣고 되읽어 대조한다. 원문은 이 함수 밖으로 나가지 않는다."""
        # 이름·주소만 넘긴다 — phone 키는 출처가 어디든 버린다
        args: dict[str, object] = {
            f: shipping[f] for f in SHIPPING_ARG_FIELDS if shipping.get(f) is not None
        }
        if not (args.get('name') and args.get('address')):
            raise AgentFailure('needs_human', '배송지를 받지 못했다', FailReason.UNKNOWN)
        if account:
            args['profile'] = account

        applied = self.json_tool(
            'run_script',
            name=source_of(self.spec.name).set_shipping_script,
            args=json.dumps(args, ensure_ascii=False),
        )
        # 원문끼리 비교하지 않는다 — 마스킹한 값끼리만 비교해서 판단에도 개인정보를 안 남긴다
        if not shipping_matches(shipping, applied):
            raise AgentFailure('needs_human', '배송지 입력 검증에 실패했다', FailReason.UNKNOWN)
        self._fill_phone(applied)
        self._confirm_shipping(shipping, args)
        # 마스킹 규칙이 이름을 가리려면 라벨이 앞에 있어야 한다(ops.masking) — 라벨을 붙여서 가린다
        summary = f'수취인 {shipping.get("name", "")} · {shipping.get("address", "")}'
        self.note('배송지', f'반영 완료 — {mask_text(summary)}')

    def _confirm_shipping(self, shipping: dict[str, object], args: dict[str, object]) -> None:
        """팝업 폼 사이트는 전화까지 채운 폼을 저장/적용해야 주문서에 반영된다(sources.yaml shipping_confirm).

        확정 스크립트가 주문서에서 되읽은 수취인·주소가 넣은 값과(마스킹 기준) 같아야 통과한다.
        """
        spec = source_of(self.spec.name)
        if not spec.shipping_confirm:
            return
        confirmed = self.json_tool(
            'run_script',
            name=spec.confirm_shipping_script,
            args=json.dumps(
                {k: v for k, v in args.items() if k in ('name', 'address', 'profile')},
                ensure_ascii=False,
            ),
        )
        if not confirmed.get('ok') or not shipping_matches(shipping, confirmed):
            raise AgentFailure(
                'needs_human',
                f'배송지 확정 검증에 실패했다: {mask_text(str(confirmed.get("note", ""))[:80])}',
                FailReason.UNKNOWN,
            )
        self.note('배송지 확정', '폼 저장 후 주문서 되읽기 일치')

    def _keep_default_shipping(self, snap: dict[str, object]) -> bool:
        """까대기 — 계정 기본 배송지가 사무실이면 그대로 두고 True(플레이북 §4-2).

        배송지 스크립트를 부르지 않고 주문서에 수령인·주소가 비어 있지 않은지만 본다.
        스냅샷이 주문서 배송지를 실어 주면 그것으로, 아니면 화면(get_page)으로 확인한다.
        비어 있거나 사무실이 아니면 False — 호출부가 사무실 주소를 주문 배송지로 넣는다.
        """
        embedded = snap.get('shipping')
        if isinstance(embedded, dict) and embedded:
            filled = all(str(embedded.get(f) or '').strip() for f in SHIPPING_FIELDS)
            office = OFFICE_ADDRESS_HINT in str(embedded.get('address') or '')
        else:
            page = self.tool('get_page')
            filled = any(m in page for m in RECIPIENT_MARKERS) and not any(
                m in page for m in EMPTY_SHIPPING_MARKERS
            )
            office = OFFICE_ADDRESS_HINT in page
        if not (filled and office):
            return False
        self.note('배송지', '사무실 수령(기본 배송지 유지)')
        return True

    def _fill_phone(self, applied: dict[str, object]) -> None:
        """배송 연락처 — 스크립트가 비워 둔 전화 칸을 앱이 키마스터 신원정보로 채운다.

        번호는 하네스를 지나가지 않는다. 앱 결과는 성공이면 'ok…', 아니면 'refused: …'·'not found: …'.
        """
        # 스크립트는 phone_field_id(칸 하나) 또는 phone_field_ids(1~3칸, 앞→뒤 순서)로 알린다.
        # 칸이 둘이면 010 은 사이트가 고정한 것이라 가운데·끝, 셋이면 앞·가운데·끝을 앱이 나눠 넣는다
        raw_ids = applied.get('phone_field_ids')
        ids = (
            _int_ids(raw_ids)
            if isinstance(raw_ids, list)
            else _int_ids([applied.get('phone_field_id')])
        )
        if not ids or len(ids) > 3:
            raise AgentFailure('needs_human', '전화 칸을 찾지 못함', FailReason.UNKNOWN)
        # 칸 하나면 앱이 저장된 번호 그대로 넣는다(format 없음). 둘·셋이면 부분 형식을 준다
        formats: list[str | None] = {
            1: [None],
            2: ['phone-mid', 'phone-last'],
            3: ['phone-first', 'phone-mid', 'phone-last'],
        }[len(ids)]
        for field_id, fmt in zip(ids, formats, strict=True):
            try:
                out = self.tool(
                    'fill_secret',
                    elementId=field_id,
                    itemType=PHONE_SECRET_ITEM,
                    field=PHONE_SECRET_FIELD,
                    **({'format': fmt} if fmt else {}),
                )
            except AgentFailure as e:
                raise AgentFailure(
                    'needs_human', f'배송 연락처 입력 실패: {e.reason}', e.fail_reason
                ) from e
            if not out.strip().lower().startswith('ok'):
                raise AgentFailure(
                    'needs_human',
                    f'배송 연락처 입력 실패: {mask_text(out.strip()[:100])}',
                    FailReason.UNKNOWN,
                )
        self.note(
            '배송 연락처', f'키마스터 신원정보로 입력({len(ids)}칸, 번호는 하네스가 보지 않는다)'
        )


class ScriptsPendingBuyer:
    """저장 스크립트가 아직 없는 소싱처(sources.yaml status: scripts_pending)의 구매 에이전트.

    등록부에는 행이 있어야 한다 — 없으면 감독자가 'unsupported' 로만 말해 준비가 어디까지 됐는지
    알 수 없다. 그래서 만들어는 두고, 부르면 곧바로 사람에게 넘긴다.
    """

    def __init__(self, spec: AgentSpec, source: Source) -> None:
        self.spec = spec
        self.source = source

    def __call__(self, assignment: Assignment) -> AgentResult:
        return AgentResult(
            status='needs_human',
            reason=f'스크립트 미작성: {self.source.id}',
            fail_reason=FailReason.UNKNOWN,
        )
