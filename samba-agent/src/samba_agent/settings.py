"""`.env` → 설정 객체. 비밀은 SecretStr 로만 들고 다녀 로그·프롬프트에 새지 않는다."""

from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

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
    slack_allowed_users: tuple[str, ...] = Field(default=(), alias='SLACK_ALLOWED_USERS')
    root: Path = Field(default=DEFAULT_ROOT, alias='SAMBA_AGENT_ROOT')
    db_path: Path = Field(default=DEFAULT_ROOT / 'jobs.sqlite', alias='SAMBA_DB_PATH')
    # 기본은 dry-run 이다. 외부 변경은 사용자 검토를 거친 뒤 명시로만 켠다(스펙 §10-1)
    dry_run: bool = Field(default=True, alias='SAMBA_DRY_RUN')

    @field_validator('slack_allowed_users', mode='before')
    @classmethod
    def _split_users(cls, v: object) -> object:
        """쉼표로 붙인 슬랙 사용자 ID 목록을 튜플로 나눈다."""
        if isinstance(v, str):
            return tuple(x.strip() for x in v.split(',') if x.strip())
        return v


def load_settings() -> Settings:
    """설정을 읽는다. 필수 값(브릿지 토큰)이 없으면 여기서 실패한다."""
    return Settings()  # type: ignore[call-arg]
