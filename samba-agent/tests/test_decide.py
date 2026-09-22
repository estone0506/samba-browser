# DecideFn 구현 — 정상 JSON / 코드펜스 안 JSON / JSON 없음 / 스키마 불일치 / 빈 응답
# 실제 Claude 호출은 하지 않는다 — query_fn 을 가짜 비동기 제너레이터로 주입한다.
import pytest
from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock

from samba_agent.agents.base import Decision
from samba_agent.llm.decide import make_decide


def assistant_text(text: str) -> AssistantMessage:
    return AssistantMessage(content=[TextBlock(text=text)], model='claude-sonnet-5')


def result_message(text: str) -> ResultMessage:
    return ResultMessage(
        subtype='success',
        duration_ms=1,
        duration_api_ms=1,
        is_error=False,
        num_turns=1,
        session_id='s1',
        result=text,
    )


def fake_query(*texts: str):
    """텍스트 조각들을 AssistantMessage 로 하나씩 내는 가짜 query_fn."""

    async def _query(*, prompt: str, options: object):
        for t in texts:
            yield assistant_text(t)

    return _query


async def _empty_query(*, prompt: str, options: object):
    return
    yield  # pragma: no cover — 제너레이터로 만들기 위한 도달 불가 yield


def test_정상_JSON_은_그대로_파싱된다():
    decide = make_decide(query_fn=fake_query('{"choice":"260","reason":"사이즈 일치"}'))
    got = decide('옵션을 고르라', Decision)
    assert (got.choice, got.reason) == ('260', '사이즈 일치')


def test_코드펜스_안_JSON_도_파싱된다():
    decide = make_decide(query_fn=fake_query('```json\n{"choice":"S","reason":"재고 있음"}\n```'))
    got = decide('옵션을 고르라', Decision)
    assert got.choice == 'S'


def test_JSON_이_없으면_ValueError():
    decide = make_decide(query_fn=fake_query('그냥 텍스트다, JSON 없음'))
    with pytest.raises(ValueError):
        decide('옵션을 고르라', Decision)


def test_스키마_불일치는_ValueError():
    decide = make_decide(query_fn=fake_query('{"choice":"260"}'))  # reason 없음
    with pytest.raises(ValueError):
        decide('옵션을 고르라', Decision)


def test_빈_응답은_ValueError():
    decide = make_decide(query_fn=_empty_query)
    with pytest.raises(ValueError):
        decide('옵션을 고르라', Decision)


def test_ResultMessage_의_result_텍스트도_읽는다():
    async def _query(*, prompt: str, options: object):
        yield result_message('{"choice":"M","reason":"결과 메시지"}')

    decide = make_decide(query_fn=_query)
    got = decide('옵션을 고르라', Decision)
    assert got.choice == 'M'
