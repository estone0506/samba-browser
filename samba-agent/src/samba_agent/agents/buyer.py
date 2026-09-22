"""구매 에이전트 — 소싱처에서 옵션·계정·배송지·결제수단을 정하는 데까지만 한다.

결제창 진입과 결제 버튼은 결제 에이전트 담당이다(등록부 tools 에 결제 도구가 없다).
사이트 차이는 등록부의 저장 스크립트 이름과 rules/*.md 가 흡수한다.
"""

from samba_agent.agents.base import AgentBase, AgentFailure, Decision, run_agent
from samba_agent.agents.contracts import AgentResult, Assignment
from samba_agent.failures import FailReason

# 소싱처별 "상품 상태 한 번에 읽기" 저장 스크립트 이름. 앱에 save_script 로 저장해 둔다
SNAPSHOT_SCRIPT = {
    'buyer.musinsa': 'musinsa_product_snapshot',
    'buyer.29cm': 'cm29_product_snapshot',
    'buyer.abc': 'abc_product_snapshot',
    'buyer.lotteon': 'lotteon_product_snapshot',
}


class BuyerAgent(AgentBase):
    """등록부의 buyer.* 한 행에 대응한다."""

    def __call__(self, assignment: Assignment) -> AgentResult:
        return run_agent(lambda: self._buy(assignment))

    def _buy(self, a: Assignment) -> AgentResult:
        self.evidence = []
        self.step(f'{self.spec.name}: 상품 확인')
        snap = self.json_tool(
            'run_script',
            name=SNAPSHOT_SCRIPT[self.spec.name],
            args=f'{{"sku":"{a.order.sku}","qty":{a.order.qty}}}',
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
            raise AgentFailure('fail', '쓸 수 있는 계정이 없다', FailReason.PERMISSION_DENIED)
        account = max(coupons, key=lambda k: coupons[k])
        self.note('계정 선택', f'{account} — 쿠폰 {coupons[account]:,.0f}원으로 가장 유리')

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
                f'옵션 {picked.choice}({picked.reason}), 계정 {account}, 카드 {card}, '
                f'원가 {cost:,.0f}원, 마진 {margin}%'
            ),
            payload={
                'option': picked.choice,
                'account': account,
                'card': card,
                'cost': cost,
                'margin_pct': margin,
            },
            evidence=tuple(self.evidence),
        )
