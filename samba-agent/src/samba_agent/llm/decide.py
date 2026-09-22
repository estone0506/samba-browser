"""`DecideFn`(프롬프트 → pydantic 모델) 을 claude-agent-sdk 로 구현한다.

`agents/base.py` 의 `DecideFn = Callable[[str, type[BaseModel]], BaseModel]` 과 모양을 맞춘다.
도구는 쓰지 않는다(`allowed_tools=[]`) — 판단은 구조화 출력만 하면 된다.
Claude 구독 로그인(로컬 Claude Code 인증)을 그대로 쓴다 — API 키는 쓰지 않는다.

비밀·개인정보 보호를 위해 프롬프트와 응답 원문은 어디에도 로그로 남기지 않는다.
"""

import asyncio
from collections.abc import AsyncIterator, Callable
from typing import Any

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ResultMessage, TextBlock
from claude_agent_sdk import query as _default_query
from pydantic import BaseModel, ValidationError

from samba_agent.agents.base import DecideFn

DEFAULT_MODEL = 'claude-sonnet-5'
# 구조화 출력 재요청은 base.decide_once 가 1 회 한다 — 여기서는 재시도하지 않는다
DEFAULT_MAX_TURNS = 1

# query() 와 같은 모양(비동기 제너레이터를 돌려주는 호출 가능 객체) — 테스트는 가짜로 주입한다
QueryFn = Callable[..., AsyncIterator[Any]]


def make_decide(
    model: str = DEFAULT_MODEL,
    max_turns: int = DEFAULT_MAX_TURNS,
    query_fn: QueryFn | None = None,
) -> DecideFn:
    """DecideFn 을 만든다. `query_fn` 을 주입하면 실제 Claude 호출 없이 테스트할 수 있다."""
    qf = query_fn or _default_query

    def decide(prompt: str, schema: type[BaseModel]) -> BaseModel:
        return asyncio.run(_ask(qf, prompt, schema, model, max_turns))

    return decide


async def _ask(
    query_fn: QueryFn,
    prompt: str,
    schema: type[BaseModel],
    model: str,
    max_turns: int,
) -> BaseModel:
    """한 번 물어서 스키마에 맞는 모델을 돌려준다. 실패는 전부 ValueError 로 바꾼다."""
    options = ClaudeAgentOptions(
        allowed_tools=[],
        system_prompt=(
            f'JSON 만 출력하라. 다른 말은 붙이지 마라. 스키마: {schema.model_json_schema()}'
        ),
        model=model,
        max_turns=max_turns,
    )
    text = ''
    async for message in query_fn(prompt=prompt, options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    text += block.text
        elif isinstance(message, ResultMessage) and message.result:
            text += message.result

    raw = _extract_first_json_object(text)
    if raw is None:
        raise ValueError('응답에서 JSON 객체를 찾지 못했다')
    try:
        return schema.model_validate_json(raw)
    except ValidationError as e:
        raise ValueError(f'응답이 스키마와 맞지 않다: {e}') from e


def _extract_first_json_object(text: str) -> str | None:
    """텍스트에서 첫 JSON 객체를 뽑는다. 코드펜스(```json ... ```) 안에 있어도 된다."""
    start = text.find('{')
    if start == -1:
        return None
    depth = 0
    for i in range(start, len(text)):
        c = text[i]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None
