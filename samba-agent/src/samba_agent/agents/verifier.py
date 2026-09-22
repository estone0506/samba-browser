"""검증 에이전트 — 소싱처 주문 상세 · SAMBA 행 · 감독자 기대값 셋을 대조한다."""

import json

from samba_agent.agents.base import AgentBase, Decision, run_agent
from samba_agent.agents.contracts import AgentResult, Assignment
from samba_agent.failures import FailReason
from samba_agent.ops.masking import mask_value

SOURCE_DETAIL_SCRIPT = 'source_order_detail'
SAMBA_READ_SCRIPT = 'samba_read_order'


class VerifierAgent(AgentBase):
    """대조만 한다. 아무것도 바꾸지 않는다(등록부 tools 에 쓰기 도구가 없다)."""

    def __call__(self, assignment: Assignment) -> AgentResult:
        return run_agent(lambda: self._verify(assignment))

    def _verify(self, a: Assignment) -> AgentResult:
        self.evidence = []
        if not a.expected:
            # 대조할 값이 하나도 없으면 '다 맞았다' 가 아니라 '확인하지 못했다' 다(리뷰 지적 — Minor)
            return AgentResult(
                status='needs_human',
                reason='대조할 기대값이 없다 — 앞 단계가 값을 넘기지 못했다',
                fail_reason=FailReason.VERIFY_MISMATCH,
                evidence=tuple(self.evidence),
            )
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
        # 대조 자체는 브릿지가 돌려준 날것 값으로 한다 — 마스킹은 밖으로 내보낼 때만 씌운다
        mismatches = [
            {'field': f, 'expected': v, 'source': source.get(f), 'samba': samba.get(f)}
            for f, v in a.expected.items()
            if source.get(f) != v or samba.get(f) != v
        ]
        # 여기서부터는 마스킹한 사본만 쓴다 — payload·reason·LLM 프롬프트 어디에도
        # 브릿지의 날것 값(고객 개인정보일 수 있다)이 그대로 나가지 않게 한다
        masked_mismatches = mask_value(mismatches)
        self.note('대조 결과', json.dumps(masked_mismatches, ensure_ascii=False) or '없음')
        if mismatches:
            explain = self.decide_once(
                f'{a.rules}\n\n다음 불일치를 한 문장으로 설명하라: {masked_mismatches}', Decision
            )
            return AgentResult(
                status='fail',
                reason=f'불일치 {len(mismatches)}건: {explain.choice}',
                fail_reason=FailReason.VERIFY_MISMATCH,
                payload={'mismatches': masked_mismatches},
                evidence=tuple(self.evidence),
            )
        return AgentResult(
            status='ok',
            reason=f'{len(a.expected)}개 값이 소싱처·SAMBA·기대값에서 모두 같다',
            payload={'mismatches': []},
            evidence=tuple(self.evidence),
        )
