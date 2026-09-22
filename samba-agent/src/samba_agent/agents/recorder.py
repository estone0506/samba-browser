"""기록 에이전트 — SAMBA-WAVE 행에 저장하고, 저장한 값을 다시 읽어 확인한다.

결제 뒤 기록이 실패해도 재결제는 절대 하지 않는다(스펙 §6). 여기서 실패하면
감독자가 needs_human 으로 넘기고 사람이 "결제됨, 기록만 남음" 을 처리한다.
"""

import json

from samba_agent.agents.base import AgentBase, AgentFailure, Decision, run_agent
from samba_agent.agents.contracts import AgentResult, Assignment
from samba_agent.failures import FailReason

SAVE_SCRIPT = 'samba_save_order'
READ_SCRIPT = 'samba_read_order'


class RecorderAgent(AgentBase):
    """SAMBA-WAVE 기록 담당."""

    # 저장하고 되읽어 확인할 필드
    RECORD_FIELDS = ('account', 'source_order_no', 'real_price', 'shipping_fee', 'memo', 'flags')

    def __call__(self, assignment: Assignment) -> AgentResult:
        return run_agent(lambda: self._record(assignment))

    def _record(self, a: Assignment) -> AgentResult:
        self.evidence = []
        self.step('recorder: 저장할 값 정리')
        memo = self.decide_once(
            f'{a.rules}\n\n주문 {a.order.order_no}({a.order.source})의 메모 한 문장을 쓰라.',
            Decision,
        )
        values: dict[str, object] = {f: a.expected.get(f) for f in self.RECORD_FIELDS}
        values['memo'] = memo.choice
        values.setdefault('shipping_fee', 0)
        self.note('저장할 값', json.dumps(values, ensure_ascii=False))

        if a.dry_run:
            self.step('recorder: dry-run — 저장하지 않는다')
            return AgentResult(
                status='ok',
                reason=f'dry-run: 저장할 값만 준비했다({memo.reason})',
                payload={'dry_run': True, 'saved': False, 'planned': values},
                evidence=tuple(self.evidence),
            )

        self.step('recorder: 저장')
        self.tool(
            'run_script',
            name=SAVE_SCRIPT,
            args=json.dumps({'orderNo': a.order.order_no, **values}, ensure_ascii=False),
        )
        self.step('recorder: 저장 확인')
        saved = self.json_tool(
            'run_script',
            name=READ_SCRIPT,
            args=json.dumps({'orderNo': a.order.order_no}, ensure_ascii=False),
        )
        diffs = [
            f
            for f in self.RECORD_FIELDS
            if values.get(f) is not None and saved.get(f) != values.get(f)
        ]
        if diffs:
            raise AgentFailure(
                'fail',
                f'저장 확인 실패(재결제 금지): {", ".join(diffs)}',
                FailReason.VERIFY_MISMATCH,
            )
        self.note('저장 확인', json.dumps(saved, ensure_ascii=False))
        return AgentResult(
            status='ok',
            reason=f'{len(self.RECORD_FIELDS)}개 필드를 저장하고 되읽어 확인했다({memo.reason})',
            payload={'dry_run': False, 'saved': True, 'values': values},
            evidence=tuple(self.evidence),
        )
