"""판매처 → 외부 기입 대상. 목록은 export.yaml 에서 고친다(코드 수정 없이)."""

import re
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict

Target = Literal['emp', 'shopmine']

_SPACES = re.compile(r'\s+')


def _norm(text: str | None) -> str:
  """비교용 — 공백을 없애고 소문자로 맞춘다('현대 h몰' == '현대H몰')."""
  return _SPACES.sub('', text or '').lower()


class ExportRouting(BaseModel):
  """라우팅 설정. 모르는 키(오타)는 조용히 버리지 않고 로딩을 거부한다."""

  model_config = ConfigDict(extra='forbid')

  # 판매처 문자열에 이 표식이 들어 있으면 EMP 에 기입한다
  emp: tuple[str, ...] = ()
  # 이 표식이 들어 있으면 어디에도 기입하지 않는다
  skip: tuple[str, ...] = ()
  # 위 둘에 해당하지 않는 판매처의 대상
  default: Target = 'shopmine'

  @classmethod
  def load(cls, path: Path) -> 'ExportRouting':
    raw = yaml.safe_load(path.read_text(encoding='utf-8')) or {}
    return cls.model_validate(raw)

  def target_for(self, seller: str | None) -> Target | None:
    """기입할 프로그램. None 이면 기입하지 않는다(제외 판매처이거나 판매처를 모른다)."""
    s = _norm(seller)
    if not s:
      return None
    # 제외가 먼저다 — 제외 표식이 EMP 표식을 품고 있어도 기입하지 않는다
    if any(_norm(m) in s for m in self.skip if _norm(m)):
      return None
    if any(_norm(m) in s for m in self.emp if _norm(m)):
      return 'emp'
    return self.default
