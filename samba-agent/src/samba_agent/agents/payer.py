"""결제 에이전트 — 코드와 도구만 쓴다. LLM 판단이 없고, 재시도도 없다(등록부 payer 행 retry: 0).

비밀번호·카드번호는 여기를 지나가지 않는다. 앱의 fill_secret 과 phone_approve_payment 가
값을 직접 채우고 우리에게는 돌려주지 않는다(docs/bridge.md). 이 파일과 결과 payload 에는
카드 브랜드명만 남고, 실제 결제 성공 문구를 화면에서 확인하기 전에는 ok 를 내지 않는다.
"""

from samba_agent.agents.base import AgentBase, AgentFailure, run_agent
from samba_agent.agents.contracts import AgentResult, Assignment
from samba_agent.failures import FailReason

# 결제 성공을 확인하는 문구. 이걸 보기 전에는 ok 를 내지 않는다(브리프 §완료조건)
PAY_SUCCESS_MARKERS = ('결제 완료', '결제완료', '주문완료', '주문 완료', 'approved')
# 폰 승인이 실패했음을 뜻하는 문구
PAY_DECLINED_MARKERS = ('declined', '거절', '실패', '취소')


class PayerAgent(AgentBase):
    """모든 소싱처의 결제를 맡는다. 등록부에서 retry: 0 이다 — 여기서도 다시 부르지 않는다."""

    def __call__(self, assignment: Assignment) -> AgentResult:
        return run_agent(lambda: self._pay(assignment))

    def _pay(self, a: Assignment) -> AgentResult:
        self.evidence = []
        card = a.options.get('card')
        if not card:
            # 감독자가 이미 검사하지만, 결제 직전에 한 번 더 막는다
            raise AgentFailure('fail', '결제할 카드가 없다', FailReason.CARD_MISSING)

        self.step('payer: 결제창 진입')
        enter = self.tool('run_script', name='checkout_enter', args=f'{{"card":"{card}"}}')
        self.note('결제창', enter[:200])

        if a.dry_run:
            # 사용자 검토 전에는 여기까지만 한다(스펙 §10-1) — 부수효과 도구는 부르지 않는다
            self.step('payer: dry-run — 결제하지 않고 끝낸다')
            return AgentResult(
                status='ok',
                reason=f'dry-run: {card} 로 결제창까지만 확인했다',
                payload={'dry_run': True, 'paid': False},
                evidence=tuple(self.evidence),
            )

        self.step('payer: 신원정보 입력')
        # 값은 앱이 직접 채운다 — 여기서는 어떤 비밀값도 보내거나 받지 않는다
        self.tool('fill_secret', field='identity', provider='site')

        self.step('payer: 폰 승인')
        approved = self.tool(
            'phone_approve_payment',
            merchant=a.order.source,
            methodLabel=card,
            card=card,
        )
        self.note('폰 승인', approved[:200])
        if any(m in approved for m in PAY_DECLINED_MARKERS):
            # 재시도 없음 — 그대로 사람에게 넘긴다(재결제 위험)
            raise AgentFailure('needs_human', f'폰 승인 실패: {approved[:100]}', FailReason.UNKNOWN)

        self.step('payer: 성공 확인')
        page = self.tool('get_page')
        if not any(m in page for m in PAY_SUCCESS_MARKERS):
            raise AgentFailure(
                'needs_human',
                '결제됐는지 화면에서 확인되지 않는다 — 사람이 봐야 한다(재결제 금지)',
                FailReason.VERIFY_MISMATCH,
            )
        self.note('결제 성공', page[:200])
        return AgentResult(
            status='ok',
            reason=f'{card} 로 결제 완료를 화면에서 확인했다',
            payload={'dry_run': False, 'paid': True, 'card': card},
            evidence=tuple(self.evidence),
        )
