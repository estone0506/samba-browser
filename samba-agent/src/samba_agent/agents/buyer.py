"""구매 에이전트 — 소싱처에서 옵션·계정·배송지·결제수단을 정하는 데까지만 한다.

결제창 진입과 결제 버튼은 결제 에이전트 담당이다(등록부 tools 에 결제 도구가 없다).
사이트 차이는 등록부의 저장 스크립트 이름과 rules/*.md 가 흡수한다.
"""

import json
import re
from collections.abc import Callable

from samba_agent.agents.base import AgentBase, AgentFailure, Decision, run_agent
from samba_agent.agents.contracts import AgentResult, Assignment, OrderRef
from samba_agent.agents.registry import AgentSpec
from samba_agent.failures import FailReason
from samba_agent.ops.masking import mask_text
from samba_agent.sources import Source, default_sources
from samba_agent.wave.client import WaveError

# 주문번호 → 배송지 사전. 개인정보라 반환값은 호출 안에서만 쓰고 버린다
# (주문번호, 배송 종류) → 배송지 사전. 배송 종류는 소싱처 강제값이 있으면 그것, 없으면 주문의 값
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
        pattern = source_of(agent_name).product_id_re
        m = pattern.search(order.product_url) if pattern else None
        return m.group(1) if m else order.product_url
    return order.sku


def snapshot_args(agent_name: str, order: OrderRef) -> str:
    """run_script 에 넘길 JSON 문자열. 옵션이 있으면 size 로, 계정이 있으면 account 로 같이 준다."""
    args: dict[str, object] = {'sku': product_ref(agent_name, order), 'qty': order.qty}
    if order.option:
        args['size'] = order.option
    if order.account:
        # 계정별 탭 프로필 — 세션(쿠키)이 계정마다 따로라 다른 계정으로 로그인된 채 사는 일이 없다
        args['account'] = order.account
        args['profile'] = order.account
    return json.dumps(args, ensure_ascii=False)


# 로그인 확인은 소싱처 첫 페이지(sources.yaml 의 home)에서 시작한다. 앱의 login 도구는 폼이 없으면
# 이미 로그인됐는지 보고, 아니면 알려진 로그인 URL(shared/site-rules)로 스스로 옮겨 간다 —
# 여기서 로그인 URL 을 알 필요가 없다
# 앱 login 도구의 결과 문자열 머리(src/main/agent/tools.ts)
ALREADY_SIGNED_IN = 'already signed in'
LOGIN_SUBMITTED = 'submitted'
# 페이지 이동·로그인 제출 뒤 화면이 안정되길 기다리는 시간
_LOGIN_SETTLE_MS = 2500


# 주문의 배송지를 앱에서 실행 시점에 읽어오는 전역 스크립트(소싱처 무관 — 주문 관리 쪽 데이터)
SHIPPING_SCRIPT = 'samba_order_shipping'

# 배송지로 다루는 필드 — 전부 개인정보라 어디에도 원문을 남기지 않는다
SHIPPING_FIELDS = ('name', 'phone', 'address')

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

    def __call__(self, assignment: Assignment) -> AgentResult:
        self._dry_run = assignment.dry_run
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

    def _ensure_login(self, a: Assignment) -> None:
        """주문의 소싱 계정으로 로그인돼 있게 한다(실기: 로그인 안 된 채 스냅샷 → 주문서 대신 로그인 페이지).

        앱 login 도구는 이미 로그인돼 있으면 누구인지까지는 말해 주지 않는다 — 계정 일치는
        스냅샷의 account 로 한 번 더 본다(_check_account).
        """
        account = a.order.account
        if not account:
            return
        home = source_of(self.spec.name).home
        if not home:
            raise AgentFailure(
                'needs_human',
                f'소싱처 첫 페이지 주소가 표에 없다: {self.spec.name}',
                FailReason.UNKNOWN,
            )
        self.step(f'{self.spec.name}: 로그인 확인({account})')
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

    def _check_account(self, a: Assignment, snap: dict[str, object]) -> None:
        """스냅샷이 로그인 계정을 알려 주면 주문의 소싱 계정과 대조한다. 다르면 사람에게 넘긴다.

        실기: 사이트가 아이디 대신 표시 이름(한글 별명 '김사무1')을 돌려주는 곳이 있다 —
        아이디끼리 비교할 때만 불일치로 본다. 표시 이름이면 대조를 못 했다고 남기고 지나간다.
        """
        seen = str(snap.get('account') or '').strip()
        want = a.order.account
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
        self._ensure_login(a)
        self.step(f'{self.spec.name}: 상품 확인')
        snap = self.json_tool(
            'run_script',
            name=source_of(self.spec.name).snapshot_script,
            args=snapshot_args(self.spec.name, a.order),
        )

        self._check_account(a, snap)
        # 같은 상품을 이미 산 흔적 — 옵션 선택 전에 끝낸다(규칙 파일 §3)
        if snap.get('already_ordered') or snap.get('existing_order_no'):
            raise AgentFailure(
                'fail', f'이미 구매한 흔적이 있다: {a.order.sku}', FailReason.DUPLICATE
            )

        options = [str(o) for o in (snap.get('options') or [])]
        if not options:
            raise AgentFailure('fail', f'옵션이 없다(품절): {a.order.sku}', FailReason.OUT_OF_STOCK)
        self.note('옵션 목록', ', '.join(options))

        picked = self.decide_once(
            f'{a.rules}\n\n주문 {a.order.order_no} 의 SKU {a.order.sku} 에 맞는 옵션을 고르라.\n'
            f'후보: {options}',
            Decision,
        )
        if picked.choice not in options:
            raise AgentFailure(
                'fail', f'고른 옵션이 목록에 없다: {picked.choice}', FailReason.OUT_OF_STOCK
            )
        self.note('옵션 선택', f'{picked.choice} — {picked.reason}')

        # 계정별 쿠폰 비교 — 스냅샷이 계정→할인액으로 준다. 가장 싼 계정을 고른다
        coupons: dict[str, float] = {
            str(k): float(v) for k, v in (snap.get('coupons') or {}).items()
        }
        if not coupons:
            # 허용 목록 밖 도구·토큰 오류·키마스터 잠김이 아니라 그냥 골라 쓸 계정이 없는 것이다
            raise AgentFailure('fail', '쓸 수 있는 계정 없음', FailReason.UNKNOWN)
        account = max(coupons, key=lambda k: coupons[k])
        self.note('계정 선택', f'{account} — 쿠폰 {coupons[account]:,.0f}원으로 가장 유리')

        # 배송지 — 개인정보(이름·전화·주소)라 Assignment/state/payload 에는 절대 담지 않는다.
        # 실행 시점에만 받아 입력 도구 호출에 바로 쓰고 로컬 변수 밖으로 내보내지 않는다.
        self._set_shipping(a, snap)

        # 결제수단·카드 — 지시받은 카드가 목록에 없으면 여기서 거절한다
        methods = [str(m) for m in (snap.get('methods') or [])]
        card = a.options.get('card')
        if card and card not in methods:
            raise AgentFailure(
                'fail', f'지시받은 카드가 결제수단에 없다: {card}', FailReason.CARD_MISSING
            )
        if not card:
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

        cost = float(snap.get('cost') or 0)
        margin = float(snap.get('margin_pct') or 0)
        if margin <= 0 and cost > 0 and a.order.sale_price > 0:
            # 스냅샷은 마진을 모른다(소싱처 페이지엔 우리 판매가가 없다) — 판매가 대비 원가로 계산
            margin = round((a.order.sale_price - cost) / a.order.sale_price * 100, 1)
            self.note(
                '마진 계산', f'판매가 {a.order.sale_price:,.0f} - 원가 {cost:,.0f} → {margin}%'
            )
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
                'shipping_set': True,
                'card': card,
                'cost': cost,
                'margin_pct': margin,
            },
            evidence=tuple(self.evidence),
        )

    def set_shipping_provider(self, provider: ShippingFn | None) -> None:
        """배송지 공급자(삼바웨이브 상세)를 꽂는다. 배선은 factory 가 한다.

        공급자를 쓰면 까대기 주문의 사무실 주소까지 삼바웨이브가 정해 준다 — 앱 화면을 거치지 않는다.
        """
        self._shipping_fn = provider

    def order_type_of(self, order: OrderRef) -> str:
        """이 주문의 배송 종류 — 소싱처가 강제하면 그것(ABC마트 = 까대기), 아니면 주문의 값."""
        forced = source_of(self.spec.name).order_type
        return forced or order.order_type

    def _fetch_shipping(self, a: Assignment, snap: dict[str, object]) -> dict[str, object]:
        """배송지 출처 — 삼바웨이브(공급자) > 스냅샷에 실려 온 값 > 전용 스크립트 순.

        어느 경로든 받은 값은 이 호출 안에서만 살아 있다(호출부가 바로 입력하고 버린다).
        """
        if self._shipping_fn is not None:
            try:
                fetched = self._shipping_fn(a.order.order_no, self.order_type_of(a.order))
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

    def _set_shipping(self, a: Assignment, snap: dict[str, object]) -> None:
        """배송지를 받아 바로 입력하고, 다시 읽어 마스킹 비교로 검증한다.

        원문은 이 함수 밖으로 나가지 않는다 — self.note 에는 마스킹된 요약만 남긴다.
        """
        shipping = self._fetch_shipping(a, snap)
        if not shipping:
            raise AgentFailure('needs_human', '배송지를 받지 못했다', FailReason.UNKNOWN)

        applied = self.json_tool(
            'run_script',
            name=source_of(self.spec.name).set_shipping_script,
            args=json.dumps(
                {**shipping, **({'profile': a.order.account} if a.order.account else {})},
                ensure_ascii=False,
            ),
        )
        # 원문끼리 비교하지 않는다 — 마스킹한 값끼리만 비교해서 판단에도 개인정보를 안 남긴다
        mismatch = any(
            mask_text(str(shipping.get(f, ''))) != mask_text(str(applied.get(f, '')))
            for f in SHIPPING_FIELDS
        )
        if mismatch:
            raise AgentFailure('needs_human', '배송지 입력 검증에 실패했다', FailReason.UNKNOWN)
        # 마스킹 규칙이 이름을 가리려면 라벨이 앞에 있어야 한다(ops.masking) — 라벨을 붙여서 가린다
        summary = (
            f'수취인 {shipping.get("name", "")} · {shipping.get("phone", "")} · '
            f'{shipping.get("address", "")}'
        )
        self.note('배송지', f'반영 완료 — {mask_text(summary)}')


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
