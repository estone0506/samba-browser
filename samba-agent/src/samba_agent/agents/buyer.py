"""구매 에이전트 — 소싱처에서 옵션·계정·배송지·결제수단을 정하는 데까지만 한다.

결제창 진입과 결제 버튼은 결제 에이전트 담당이다(등록부 tools 에 결제 도구가 없다).
사이트 차이는 등록부의 저장 스크립트 이름과 rules/*.md 가 흡수한다.
"""

import json

from samba_agent.agents.base import AgentBase, AgentFailure, Decision, run_agent
from samba_agent.agents.contracts import AgentResult, Assignment
from samba_agent.failures import FailReason
from samba_agent.ops.masking import mask_text

# 소싱처별 "상품 상태 한 번에 읽기" 저장 스크립트 이름. 앱에 save_script 로 저장해 둔다
SNAPSHOT_SCRIPT = {
    'buyer.musinsa': 'musinsa_product_snapshot',
    'buyer.29cm': 'cm29_product_snapshot',
    'buyer.abc': 'abc_product_snapshot',
    'buyer.lotteon': 'lotteon_product_snapshot',
}

# 주문의 배송지를 앱에서 실행 시점에 읽어오는 전역 스크립트(소싱처 무관 — 주문 관리 쪽 데이터)
SHIPPING_SCRIPT = 'samba_order_shipping'

# 소싱처별 "배송지 입력" 저장 스크립트 이름
SET_SHIPPING_SCRIPT = {
    'buyer.musinsa': 'musinsa_set_shipping',
    'buyer.29cm': 'cm29_set_shipping',
    'buyer.abc': 'abc_set_shipping',
    'buyer.lotteon': 'lotteon_set_shipping',
}

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

    def __call__(self, assignment: Assignment) -> AgentResult:
        self._dry_run = assignment.dry_run
        return run_agent(lambda: self._buy(assignment))

    def tool(self, name: str, /, **args: object) -> str:
        """dry_run 이면 부수효과 도구는 허용 목록에 있어도 아예 부르지 않는다(불변조건)."""
        if self._dry_run and name in DRY_RUN_BLOCKED_TOOLS:
            raise AgentFailure(
                'fail',
                f'dry_run 에서는 부수효과 도구를 부르지 않는다: {name}',
                FailReason.PERMISSION_DENIED,
            )
        return super().tool(name, **args)

    def _buy(self, a: Assignment) -> AgentResult:
        self.evidence = []
        self.step(f'{self.spec.name}: 상품 확인')
        snap = self.json_tool(
            'run_script',
            name=SNAPSHOT_SCRIPT[self.spec.name],
            args=f'{{"sku":"{a.order.sku}","qty":{a.order.qty}}}',
        )

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

    def _fetch_shipping(self, a: Assignment, snap: dict[str, object]) -> dict[str, object]:
        """스냅샷 응답에 배송지가 실려 있으면 그걸 쓰고, 없으면 전용 스크립트로 받는다."""
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
            name=SET_SHIPPING_SCRIPT[self.spec.name],
            args=json.dumps(shipping, ensure_ascii=False),
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
