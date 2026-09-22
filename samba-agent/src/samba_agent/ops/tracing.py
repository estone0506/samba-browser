"""LangSmith 추적 + 로컬 사본(스펙 §4.5 1단계 Observe).

나가는 값은 전부 masking 을 지난다. 키가 없거나 LangSmith 가 끊기면 경고만 남기고
실행은 계속된다 — 로컬 events.sqlite 에는 그대로 남는다.
"""

import functools
import logging
import os
import time
from collections.abc import Callable, Mapping

from samba_agent.ops.events import EventLog
from samba_agent.ops.masking import mask_text, mask_value
from samba_agent.settings import Settings

log = logging.getLogger(__name__)

REQUIRED_METADATA = (
    'harness_version',
    'env',
    'order_no',
    'source',
    'agent',
    'requester',
    'job_id',
    'prompt_commit',
)
# 환경 이름 → LangSmith 프로젝트(스펙 §4.5)
PROJECT_OF_ENV = {'dev': 'samba-dev', 'staging': 'samba-staging', 'prod': 'samba-prod'}


def configure_tracing(settings: Settings) -> bool:
    """LangSmith 를 켠다. 키가 없으면 False — 경고만 하고 실행은 계속한다."""
    key = settings.langsmith_api_key
    if key is None or key.get_secret_value() == '':
        log.warning('LangSmith 키가 없어 추적을 건너뛴다(로컬 events 만 남는다)')
        os.environ['LANGSMITH_TRACING'] = 'false'
        return False
    os.environ['LANGSMITH_TRACING'] = 'true'
    os.environ['LANGSMITH_API_KEY'] = key.get_secret_value()
    os.environ['LANGSMITH_PROJECT'] = PROJECT_OF_ENV[settings.harness_env]
    return True


def run_metadata(
    *,
    job_id: int,
    order_no: str,
    source: str,
    requester: str,
    agent: str,
    version: str,
    env: str,
    prompt_commit: str,
) -> dict[str, str]:
    """모든 span 에 붙는 태그. 진단 표가 이걸로 집계한다."""
    return {
        'harness_version': version,
        'env': env,
        'order_no': order_no,
        'source': source,
        'agent': agent,
        'requester': requester,
        'job_id': str(job_id),
        'prompt_commit': prompt_commit,
    }


def outcome_metadata(
    *,
    outcome: str,
    fail_reason: str | None,
    cost_krw: float | None,
    margin_pct: float | None,
    duration_ms: int,
) -> dict[str, object]:
    """실행 결과 span 에 붙는 값."""
    return {
        'outcome': outcome,
        'fail_reason': fail_reason or '',
        # `or 0` 은 0.0 같은 정상값도 없앤다 — None 인지만 본다.
        'cost_krw': cost_krw if cost_krw is not None else 0,
        'margin_pct': margin_pct if margin_pct is not None else 0,
        'duration_ms': duration_ms,
    }


def traced(name: str, *, metadata: Mapping[str, str], events: EventLog | None = None):
    """함수 1개를 LangSmith span + 로컬 이벤트로 남긴다. 값은 전부 마스킹을 지난다."""

    def wrap(fn: Callable[..., object]) -> Callable[..., object]:
        @functools.wraps(fn)
        def inner(*args: object, **kwargs: object) -> object:
            started = time.monotonic()
            try:
                from langsmith import traceable
            except ImportError:  # langsmith 미설치 — 로컬만 남긴다
                runner = fn
            else:
                try:
                    runner = traceable(
                        name=name,
                        metadata=dict(metadata),
                        process_inputs=mask_value,
                        process_outputs=mask_value,
                    )(fn)
                except Exception as setup_exc:  # noqa: BLE001 — traceable 설정 실패, 로컬만 남긴다
                    log.warning('LangSmith traceable 설정 실패(%s), 로컬만 남긴다', setup_exc)
                    runner = fn
            ok = True
            masked_error: str | None = None
            try:
                return runner(*args, **kwargs)
            except Exception as exc:
                ok = False
                masked_error = mask_text(str(exc))
                # 원래 타입을 유지해 재던진다(불가하면 RuntimeError) — 예외 메시지에
                # 개인정보가 있어도 LangSmith·로컬 events 로는 가려진 메시지만 나간다.
                try:
                    reraised = type(exc)(masked_error)
                except Exception:  # noqa: BLE001 — 타입이 문자열 1개로 생성 안 되면 폴백
                    reraised = RuntimeError(masked_error)
                raise reraised from exc
            finally:
                if events is not None:
                    payload: dict[str, object] = {
                        # 판정(ops.gate._observe_ok)이 필수 메타데이터를 여기서 찾는다.
                        # events 테이블 컬럼만으로는 order_no·source·requester·prompt_commit
                        # 이 비어 관측 조건이 서지 않는다(리뷰 지적 — I3)
                        'metadata': dict(metadata),
                        'ok': ok,
                        'duration_ms': int((time.monotonic() - started) * 1000),
                        'args': mask_value(list(args)),
                        'kwargs': mask_value(dict(kwargs)),
                    }
                    if masked_error is not None:
                        payload['error'] = masked_error
                    events.write(
                        job_id=int(metadata.get('job_id', 0)),
                        version=str(metadata.get('harness_version', '')),
                        env=str(metadata.get('env', '')),
                        agent=str(metadata.get('agent', name)),
                        kind=name,
                        payload=payload,
                    )

        return inner

    return wrap
