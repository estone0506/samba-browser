"""`.env` → 설정 객체. 비밀은 SecretStr 로만 들고 다녀 로그·프롬프트에 새지 않는다."""

from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# 이 파일 기준 samba-agent/ 폴더 — registry.yaml 과 rules/ 가 있는 곳
DEFAULT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """하네스 설정. 이름은 환경변수 이름과 1:1 이다."""

    model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', extra='ignore')

    bridge_url: str = Field(default='http://127.0.0.1:47811', alias='SAMBA_BRIDGE_URL')
    bridge_token: SecretStr = Field(alias='SAMBA_BRIDGE_TOKEN')
    harness_env: Literal['dev', 'staging', 'prod'] = Field(default='dev', alias='HARNESS_ENV')
    langsmith_api_key: SecretStr | None = Field(default=None, alias='LANGSMITH_API_KEY')
    slack_bot_token: SecretStr | None = Field(default=None, alias='SLACK_BOT_TOKEN')
    slack_app_token: SecretStr | None = Field(default=None, alias='SLACK_APP_TOKEN')
    slack_channel: str = Field(default='#sambaorder', alias='SLACK_CHANNEL')
    # NoDecode: 환경변수 값을 JSON 으로 풀지 않고 아래 검증기가 쉼표로 나눈다(예: U1,U2)
    slack_allowed_users: Annotated[tuple[str, ...], NoDecode] = Field(
        default=(), alias='SLACK_ALLOWED_USERS'
    )
    root: Path = Field(default=DEFAULT_ROOT, alias='SAMBA_AGENT_ROOT')
    db_path: Path = Field(default=DEFAULT_ROOT / 'jobs.sqlite', alias='SAMBA_DB_PATH')
    # 판정·진단 산출물 위치. gate·eval·API 가 같은 곳을 본다(리뷰 지적 — I4)
    report_dir: Path = Field(default=DEFAULT_ROOT / 'ops' / 'reports', alias='SAMBA_REPORT_DIR')
    # 프롬프트 허브 커밋 — 추적 메타데이터에 실린다. 허브를 안 쓰면 'local' 이다
    prompt_commit: str = Field(default='local', alias='SAMBA_PROMPT_COMMIT')
    # 기본은 dry-run 이다. 외부 변경은 사용자 검토를 거친 뒤 명시로만 켠다(스펙 §10-1)
    dry_run: bool = Field(default=True, alias='SAMBA_DRY_RUN')
    # dry-run 에서 결제 비밀번호를 몇 자리까지 눌러 보고 취소할지(0 이면 결제창까지만).
    # 실기에서 키패드 자동 입력이 되는지만 보는 값이라 앱 스키마와 같은 1~3 자리를 쓴다
    dry_run_digits: int = Field(default=0, ge=0, le=3, alias='SAMBA_DRY_RUN_DIGITS')

    @field_validator('slack_allowed_users', mode='before')
    @classmethod
    def _split_users(cls, v: object) -> object:
        """쉼표로 붙인 슬랙 사용자 ID 목록을 튜플로 나눈다."""
        if isinstance(v, str):
            return tuple(x.strip() for x in v.split(',') if x.strip())
        return v


def load_settings(env_file: str | Path | None = '.env') -> Settings:
    """설정을 읽는다. 필수 값(브릿지 토큰)이 없으면 여기서 실패한다.

    env_file=None 이면 `.env` 를 읽지 않고 환경변수만 본다(테스트가 로컬 .env 에 물들지 않게)."""
    return Settings(_env_file=env_file)  # type: ignore[call-arg]


def default_report_dir() -> Path:
    """판정·실험 산출물 폴더. `SAMBA_REPORT_DIR` 가 있으면 그것, 없으면 `root/ops/reports`.

    gate·eval 은 모듈 상수로, API 는 root 기준 경로로 각자 다른 곳을 보고 있었다
    (리뷰 지적 — I4). 설정 하나로 모은다. `.env` 는 읽지 않는다 — 모듈 로딩 시점에
    불리는 함수라 환경변수만 본다.
    """
    import os

    raw = os.environ.get('SAMBA_REPORT_DIR')
    if raw:
        return Path(raw)
    root = os.environ.get('SAMBA_AGENT_ROOT')
    return (Path(root) if root else DEFAULT_ROOT) / 'ops' / 'reports'
