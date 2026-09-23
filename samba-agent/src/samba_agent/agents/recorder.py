"""기록 에이전트 — SAMBA-WAVE 행에 저장하고, 저장한 값을 다시 읽어 확인한다.

결제 뒤 기록이 실패해도 재결제는 절대 하지 않는다(스펙 §6). 여기서 실패하면
감독자가 needs_human 으로 넘기고 사람이 "결제됨, 기록만 남음" 을 처리한다.

재시도가 재저장(중복 행)으로 이어지지 않도록, 저장 전에 먼저 읽어 이미 저장된
주문인지 확인한다 — 있으면 저장을 건너뛰고 재확인만 한다.
"""

import json

from samba_agent.agents.base import AgentBase, AgentFailure, Decision, run_agent
from samba_agent.agents.contracts import AgentResult, Assignment
from samba_agent.failures import FailReason
from samba_agent.wave.client import WaveClient, WaveError, wave_fields

SAVE_SCRIPT = 'samba_save_order'
READ_SCRIPT = 'samba_read_order'

# 되읽어 숫자로 비교할 필드 — 문자열 "89000" 과 숫자 89000 을 같은 값으로 본다
NUMERIC_FIELDS = ('real_price', 'shipping_fee')


def _normalize(field: str, value: object) -> object:
    """되읽기 비교용 타입 정규화 — 숫자 필드는 숫자로, 문자열은 strip 해서 비교한다."""
    if value is None:
        return None
    if field in NUMERIC_FIELDS:
        try:
            return float(value)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return value
    if isinstance(value, str):
        return value.strip()
    return value


class RecorderAgent(AgentBase):
    """SAMBA-WAVE 기록 담당. 내부 API 가 꽂혀 있으면 앱 화면 대신 그쪽에 기입한다."""

    # 저장하고 되읽어 확인할 필드
    RECORD_FIELDS = ('account', 'source_order_no', 'real_price', 'shipping_fee', 'memo', 'flags')

    # 삼바웨이브 내부 API 클라이언트. factory 가 꽂는다(없으면 앱 저장 스크립트 경로)
    _wave: 'WaveClient | None' = None

    def set_wave(self, wave: 'WaveClient | None') -> None:
        """삼바웨이브 클라이언트를 꽂는다. 배선은 factory 가 한다."""
        self._wave = wave

    def __call__(self, assignment: Assignment) -> AgentResult:
        return run_agent(lambda: self._record(assignment), lambda: self.evidence)

    def _record(self, a: Assignment) -> AgentResult:
        self.evidence = []
        self.step('recorder: 저장할 값 정리')
        memo = self.decide_once(
            f'{a.rules}\n\n주문 {a.order.order_no}({a.order.source})의 메모 한 문장을 쓰라.',
            Decision,
        )
        # account 는 내부 판매 계정 식별자다. 요청자가 지정했으면 그 값을, 아니면 구매
        # 에이전트가 고른 계정을 인계값에서 받는다 — 둘 다 없으면 빈 계정으로 저장된다
        # (리뷰 지적 — I1)
        values: dict[str, object] = {
            f: a.expected.get(f) for f in self.RECORD_FIELDS if f not in ('account', 'shipping_fee')
        }
        account = a.options.get('account') or a.handoff.get('account')
        if not account:
            raise AgentFailure('needs_human', '저장할 판매 계정이 없다', FailReason.UNKNOWN)
        values['account'] = account
        values['shipping_fee'] = a.expected.get('shipping_fee', 0)
        values['memo'] = memo.choice
        self.note('저장할 값', json.dumps(values, ensure_ascii=False))

        if a.dry_run:
            self.step('recorder: dry-run — 저장하지 않는다')
            return AgentResult(
                status='ok',
                reason=f'dry-run: 저장할 값만 준비했다({memo.reason})',
                payload={'dry_run': True, 'saved': False, 'planned': values},
                evidence=tuple(self.evidence),
            )

        if self._wave is not None:
            return self._record_via_wave(a, values, memo.reason)

        self.step('recorder: 기존 저장 확인')
        existing = self.json_tool(
            'run_script',
            name=READ_SCRIPT,
            args=json.dumps({'orderNo': a.order.order_no}, ensure_ascii=False),
        )
        already_saved = bool(existing)
        if already_saved:
            # 저장은 됐는데 되읽기만 어긋난 경우일 수 있다 — 다시 저장하지 않고 재확인만 한다
            self.step('recorder: 이미 저장됨 — 재저장 없이 재확인만')
            saved = existing
        else:
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
            if values.get(f) is not None
            and _normalize(f, saved.get(f)) != _normalize(f, values.get(f))
        ]
        if diffs:
            raise AgentFailure(
                'fail',
                f'저장 확인 실패(재결제 금지): {", ".join(diffs)}',
                FailReason.VERIFY_MISMATCH,
            )
        self.note('저장 확인', json.dumps(saved, ensure_ascii=False))
        reason = (
            f'이미 저장된 주문이라 재저장 없이 재확인만 했다({memo.reason})'
            if already_saved
            else f'{len(self.RECORD_FIELDS)}개 필드를 저장하고 되읽어 확인했다({memo.reason})'
        )
        return AgentResult(
            status='ok',
            reason=reason,
            payload={
                'dry_run': False,
                'saved': True,
                'values': values,
                'already_saved': already_saved,
            },
            evidence=tuple(self.evidence),
        )

    def _record_via_wave(
        self, a: Assignment, values: dict[str, object], memo_reason: str
    ) -> AgentResult:
        """삼바웨이브 내부 API 로 기입하고 되읽어 확인한다.

        재결제는 절대 하지 않는다(스펙 §6) — 이미 다른 소싱주문번호가 박혀 있으면(409)
        덮어쓰지 않고 사람에게 넘긴다.
        """
        sourcing_no = str(values.get('source_order_no') or '').strip()
        if not sourcing_no:
            raise AgentFailure('needs_human', '기입할 소싱주문번호가 없다', FailReason.UNKNOWN)
        self.step('recorder: 삼바웨이브 기입')
        try:
            self._wave.record_sourcing(  # type: ignore[union-attr]
                a.order.order_no,
                sourcing_order_number=sourcing_no,
                cost=float(values.get('real_price') or 0),
                shipping_fee=float(values.get('shipping_fee') or 0),
                sourcing_account_id=str(a.handoff.get('sourcing_account_id') or '') or None,
                notes=str(values.get('memo') or '') or None,
            )
            self.step('recorder: 기입 확인')
            saved = self._wave.get_order(a.order.order_no)  # type: ignore[union-attr]
        except WaveError as e:
            status = 'needs_human' if e.reason is FailReason.DUPLICATE else 'fail'
            raise AgentFailure(status, f'삼바웨이브 기입 실패(재결제 금지): {e}', e.reason) from e

        # 응답이 돌려주는 필드만 대조한다 — 목록 모델에 없는 값(소싱주문번호 등)은 확인할 수 없다.
        # PUT 이 200 이면 저장은 된 것이고, 다른 번호가 있었다면 409 로 막혔다
        checked = wave_fields(saved)
        diffs = [
            f
            for f, v in checked.items()
            if values.get(f) is not None and _normalize(f, v) != _normalize(f, values.get(f))
        ]
        if diffs:
            raise AgentFailure(
                'fail',
                f'기입 확인 실패(재결제 금지): {", ".join(diffs)}',
                FailReason.VERIFY_MISMATCH,
            )
        self.note(
            '기입 확인',
            json.dumps(checked, ensure_ascii=False)
            if checked
            else '삼바웨이브 응답에 대조할 필드가 없다 — 기입 자체는 200 으로 확인',
        )
        return AgentResult(
            status='ok',
            reason=f'삼바웨이브에 소싱주문번호 {sourcing_no} 를 기입하고 되읽어 확인했다({memo_reason})',
            payload={'dry_run': False, 'saved': True, 'values': values, 'via': 'wave'},
            evidence=tuple(self.evidence),
        )
