# 진입점 배선 — 승인 요청이 버튼 있는 경로로, 진행 보고가 평문 경로로 나가는지
from samba_agent.__main__ import make_reporters


class _FakeBot:
    """SambaBot 의 발신 두 메서드만 흉내 낸다."""

    def __init__(self, ok: bool = True) -> None:
        self.ok = ok
        self.posts: list[tuple[str | None, str]] = []
        self.approvals: list[tuple[str | None, str, str, str]] = []

    def post(self, thread_ts, text, blocks=None):  # type: ignore[no-untyped-def]
        self.posts.append((thread_ts, text))
        return self.ok

    def post_approval(self, thread_ts, order_no, stage, summary):  # type: ignore[no-untyped-def]
        self.approvals.append((thread_ts, order_no, stage, summary))
        return self.ok


class _Job:
    order_no = 'A1'
    thread_ts = 'ts1'


def test_진입점은_승인_요청을_버튼_경로로_배선한다():
    # 리뷰 지적 — Critical 1
    bot = _FakeBot()
    _report, approval_report = make_reporters(lambda: bot)
    approval_report(_Job(), 'A1', 'pay', '요약')
    assert bot.approvals == [('ts1', 'A1', 'pay', '요약')]
    assert bot.posts == []


def test_진입점의_진행_보고는_평문_경로로_간다():
    bot = _FakeBot()
    report, _ = make_reporters(lambda: bot)
    report(_Job(), '접수: A1')
    assert bot.posts == [('ts1', '접수: A1')]


def test_슬랙이_없으면_보고는_조용히_로그로만_남는다():
    bot = _FakeBot(ok=False)
    report, approval_report = make_reporters(lambda: bot)
    report(_Job(), '접수: A1')  # 예외가 나지 않는다
    approval_report(_Job(), 'A1', 'pay', '요약')
