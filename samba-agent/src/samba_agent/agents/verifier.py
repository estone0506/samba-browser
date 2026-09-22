"""검증 에이전트 — 소싱처 주문 상세 · SAMBA 행 · 감독자 기대값 셋을 대조한다."""

import json

from samba_agent.agents.base import AgentBase, Decision, run_agent
from samba_agent.agents.contracts import AgentResult, Assignment
from samba_agent.failures import FailReason

SOURCE_DETAIL_SCRIPT = 'source_order_detail'
SAMBA_READ_SCRIPT = 'samba_read_order'


class VerifierAgent(AgentBase):
    """대조만 한다. 아무것도 바꾸지 않는다(등록부 tools 에 쓰기 도구가 없다)."""

    def __call__(self, assignment: Assignment) -> AgentResult:
        return run_agent(lambda: self._verify(assignment))

    def _verify(self, a: Assignment) -> AgentResult:
        self.evidence = []
        self.step('verifier: 소싱처 주문 상세 읽기')
        source = self.json_tool(
            'run_script',
            name=SOURCE_DETAIL_SCRIPT,
            args=json.dumps(
                {'orderNo': a.order.order_no, 'site': a.order.source}, ensure_ascii=False
            ),
        )
        self.step('verifier: SAMBA 행 읽기')
        samba = self.json_tool(
            'run_script',
            name=SAMBA_READ_SCRIPT,
            args=json.dumps({'orderNo': a.order.order_no}, ensure_ascii=False),
        )
        mismatches = [
            {'field': f, 'expected': v, 'source': source.get(f), 'samba': samba.get(f)}
            for f, v in a.expected.items()
            if source.get(f) != v or samba.get(f) != v
        ]
        self.note('대조 결과', json.dumps(mismatches, ensure_ascii=False) or '없음')
        if mismatches:
            explain = self.decide_once(
                f'{a.rules}\n\n다음 불일치를 한 문장으로 설명하라: {mismatches}', Decision
            )
            return AgentResult(
                status='fail',
                reason=f'불일치 {len(mismatches)}건: {explain.choice}',
                fail_reason=FailReason.VERIFY_MISMATCH,
                payload={'mismatches': mismatches},
                evidence=tuple(self.evidence),
            )
        return AgentResult(
            status='ok',
            reason=f'{len(a.expected)}개 값이 소싱처·SAMBA·기대값에서 모두 같다',
            payload={'mismatches': []},
            evidence=tuple(self.evidence),
        )
