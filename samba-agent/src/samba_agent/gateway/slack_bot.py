"""슬랙 봇(Socket Mode) — 지시 받기 · 진행 보고 · 승인 버튼(스펙 §4.1).

바깥 세계와 닿는 유일한 창구다. 등록되지 않은 사용자와 다른 채널은 조용히 무시한다
(답장조차 하지 않는다 — 스펙 §4.1).
"""

import logging
from typing import TYPE_CHECKING

from samba_agent.gateway.commands import Command, parse_command
from samba_agent.ops.masking import mask_text
from samba_agent.queue.db import JobQueue
from samba_agent.queue.worker import Worker
from samba_agent.settings import Settings

if TYPE_CHECKING:
    from collections.abc import Callable

    from slack_bolt import App

log = logging.getLogger(__name__)

APPROVE_ACTION_ID = 'samba_approve'
REJECT_ACTION_ID = 'samba_reject'


def approval_blocks(order_no: str, stage: str, summary: str) -> list[dict[str, object]]:
    """승인 요청 메시지. 버튼 값에 주문번호를 실어 누가 눌러도 어느 건인지 안다."""
    return [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': summary}},
        {
            'type': 'actions',
            'elements': [
                {
                    'type': 'button',
                    'action_id': APPROVE_ACTION_ID,
                    'style': 'primary',
                    'text': {'type': 'plain_text', 'text': '승인'},
                    'value': f'{order_no}|{stage}',
                },
                {
                    'type': 'button',
                    'action_id': REJECT_ACTION_ID,
                    'style': 'danger',
                    'text': {'type': 'plain_text', 'text': '거부'},
                    'value': f'{order_no}|{stage}',
                },
            ],
        },
    ]


class SambaBot:
    """명령 처리 알맹이. 슬랙 App 은 얇게 감싸기만 한다."""

    def __init__(
        self,
        app: 'App | None',
        worker: Worker,
        queue: JobQueue,
        settings: Settings,
        diagnose: 'Callable[[str | None], str]',
    ) -> None:
        self.app = app
        self.worker = worker
        self.queue = queue
        self.settings = settings
        self.diagnose = diagnose

    def _allowed(self, user: str) -> bool:
        """등록부가 비어 있으면 아무도 못 시킨다 — 실수로 열려 있는 걸 막는다."""
        return user in self.settings.slack_allowed_users

    def handle_mention(self, text: str, user: str, thread_ts: str | None) -> str | None:
        """멘션 1건. 답할 말이 없으면 None(봇이 조용히 넘어간다)."""
        if not self._allowed(user):
            log.info('미등록 사용자 명령 무시: %s', user)
            return None
        cmd = parse_command(text)
        answer = self._dispatch(cmd, user, thread_ts)
        # 진행 보고·진단 문구에는 고객 개인정보가 섞일 수 있어 슬랙에 나가기 전에 마지막으로 한 번 더 가린다
        return mask_text(answer) if answer is not None else None

    def _dispatch(self, cmd: Command, user: str, thread_ts: str | None) -> str | None:
        if cmd.kind == 'process' and cmd.order_no:
            job, created = self.queue.enqueue(cmd.order_no, user, dict(cmd.options), thread_ts)
            if not created:
                where = f'{job.assignee_agent or "대기"} · {job.step or job.state}'
                return f'이미 <@{job.requester}>님이 처리 중입니다({where})'
            return f'접수했습니다: {cmd.order_no}' + (
                f' (카드 {cmd.options["card"]})' if cmd.options.get('card') else ''
            )
        if cmd.kind == 'status':
            live = self.queue.live()
            if not live:
                return '지금 도는 주문이 없습니다'
            return '\n'.join(
                f'{j.order_no} · {j.state} · {j.assignee_agent or "-"} · {j.step or "-"}'
                for j in live
            )
        if cmd.kind == 'cancel' and cmd.order_no:
            job = self.queue.cancel(cmd.order_no)
            return (
                f'{cmd.order_no} 취소했습니다' if job else f'{cmd.order_no} 는 취소할 게 없습니다'
            )
        if cmd.kind == 'resume' and cmd.order_no:
            job = self.queue.get(cmd.order_no)
            if job is None:
                return f'{cmd.order_no} 는 없는 주문입니다'
            try:
                self.queue.retry(job.id)
            except ValueError as e:
                return str(e)
            return f'{cmd.order_no} 를 다시 큐에 넣었습니다'
        if cmd.kind == 'diagnose':
            return self.diagnose(cmd.order_no)
        if cmd.kind == 'version':
            return f'하네스 버전 {self.worker.d.version} · 환경 {self.settings.harness_env}'
        if cmd.kind == 'approve' and cmd.version:
            # 버전 승격 승인은 Task 15 의 ops.gate 가 받는다
            return f'버전 {cmd.version} 승인 요청을 접수했습니다(판정 파일에 기록)'
        return None

    def handle_approval(self, order_no: str, approved: bool, user: str) -> str:
        """승인·거부 버튼. 누른 사람도 등록돼 있어야 한다."""
        if not self._allowed(user):
            log.info('미등록 사용자 승인 무시: %s', user)
            return '권한이 없습니다'
        job = self.worker.resume(order_no, approved=approved, by=user)
        if job is None:
            return f'{order_no} 는 승인 대기 상태가 아닙니다'
        answer = (
            f'<@{user}>님이 {order_no} 를 승인했습니다 → {job.state}'
            if approved
            else f'<@{user}>님이 {order_no} 를 거부했습니다 → {job.state}'
        )
        return mask_text(answer)

    def start(self) -> None:
        """Socket Mode 로 슬랙에 붙는다. 검토 전에는 테스트 채널만 쓴다(스펙 §7 ④)."""
        from slack_bolt.adapter.socket_mode import SocketModeHandler

        @self.app.event('app_mention')
        def _on_mention(event, say):  # type: ignore[no-untyped-def]
            if event.get('channel_type') == 'im':
                return
            answer = self.handle_mention(
                event.get('text', ''),
                event.get('user', ''),
                event.get('thread_ts') or event.get('ts'),
            )
            if answer:
                say(text=answer, thread_ts=event.get('thread_ts') or event.get('ts'))

        @self.app.action(APPROVE_ACTION_ID)
        def _on_approve(ack, body, say):  # type: ignore[no-untyped-def]
            ack()
            order_no = str(body['actions'][0]['value']).split('|')[0]
            say(
                text=self.handle_approval(order_no, True, body['user']['id']),
                thread_ts=body['message'].get('thread_ts') or body['message']['ts'],
            )

        @self.app.action(REJECT_ACTION_ID)
        def _on_reject(ack, body, say):  # type: ignore[no-untyped-def]
            ack()
            order_no = str(body['actions'][0]['value']).split('|')[0]
            say(
                text=self.handle_approval(order_no, False, body['user']['id']),
                thread_ts=body['message'].get('thread_ts') or body['message']['ts'],
            )

        # 토큰은 여기서 값으로 한 번만 풀리고 로그로 나가지 않는다(비밀은 SecretStr 로만 들고 다닌다)
        token = self.settings.slack_app_token
        SocketModeHandler(self.app, token.get_secret_value() if token else '').start()
