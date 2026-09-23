"""소싱처 표(sources.yaml). 새 소싱처 = 여기 1행이면 등록부·스크립트 이름·상품 ID 규칙이 따라온다.

한 줄 요약: `id` 는 삼바웨이브 `source_site` 값, `key` 는 앱 저장 스크립트 이름의 접두어,
`label` 은 사람이 보는 한글 이름이다. 조회 결과가 한글 이름으로 와도 이 표를 거쳐 id 로 맞춘다.
"""

import re
from collections.abc import Iterator
from functools import lru_cache
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict

from samba_agent.settings import DEFAULT_ROOT

SOURCES_FILE = 'sources.yaml'

# active: 저장 스크립트가 다 있다 · scripts_pending: 등록은 하되 구매를 시작하면 사람에게 넘긴다
# hold: 아예 등록하지 않는다(감독자가 unsupported 로 넘긴다)
SourceStatus = Literal['active', 'scripts_pending', 'hold']


class Source(BaseModel):
    """소싱처 1행. 모르는 필드(오타)는 조용히 버리지 않고 로딩을 거부한다."""

    model_config = ConfigDict(extra='forbid')

    id: str  # 삼바웨이브 source_site 값(MUSINSA·29CM·ABCmart·…)
    key: str  # 스크립트 접두어: <key>_product_snapshot · <key>_set_shipping · checkout_enter_<key>
    label: str  # 표시·별칭(조회 결과의 '무신사' 도 이 id 로 정규화된다)
    home: str | None = None  # 로그인 확인을 시작할 첫 페이지. 모르면 비워 둔다
    login_host: str | None = None
    product_id: str | None = None  # 상품 URL 에서 스냅샷 sku 로 넘길 ID 정규식(없으면 URL 그대로)
    # 이름 규칙을 벗어나는 결제창 진입 스크립트(29CM 는 checkout_enter_29cm 로 이미 저장돼 있다)
    checkout_script: str | None = None
    status: SourceStatus = 'active'

    @property
    def product_id_re(self) -> re.Pattern[str] | None:
        return re.compile(self.product_id) if self.product_id else None

    @property
    def snapshot_script(self) -> str:
        return f'{self.key}_product_snapshot'

    @property
    def set_shipping_script(self) -> str:
        return f'{self.key}_set_shipping'

    @property
    def checkout_script_name(self) -> str:
        return self.checkout_script or f'checkout_enter_{self.key}'

    @property
    def agent_name(self) -> str:
        return f'buyer.{self.key}'


class Sources:
    """sources.yaml 을 읽어 들고 있는 객체. id·한글 이름·key 어느 것으로 물어도 같은 행을 준다."""

    def __init__(self, rows: list[Source]) -> None:
        self._rows = rows
        self._index: dict[str, Source] = {}
        for s in rows:
            for alias in (s.id, s.label, s.key):
                self._index.setdefault(alias.strip().lower(), s)

    @classmethod
    def load(cls, root: Path, filename: str = SOURCES_FILE) -> 'Sources':
        raw = yaml.safe_load((root / filename).read_text(encoding='utf-8')) or {}
        rows = [Source.model_validate(row) for row in raw.get('sources', [])]
        seen_ids: set[str] = set()
        for s in rows:
            if s.id in seen_ids:
                raise ValueError(f'소싱처 id 가 중복이다: {s.id}')
            seen_ids.add(s.id)
        return cls(rows)

    def by_id(self, id_or_label: str | None) -> Source | None:
        """id·한글 이름·key 아무거나로 찾는다(대소문자 무시). 없으면 None."""
        if not id_or_label:
            return None
        return self._index.get(str(id_or_label).strip().lower())

    def normalize(self, id_or_label: str | None) -> str | None:
        """소싱처 이름을 삼바웨이브 id 로 맞춘다. 표에 없으면 받은 값 그대로 둔다."""
        found = self.by_id(id_or_label)
        return found.id if found else id_or_label

    def by_agent(self, agent_name: str) -> Source | None:
        """'buyer.abc' → key 가 abc 인 첫 행. 흐름을 공유하는 소싱처(그랜드스테이지)는 첫 행을 따른다."""
        key = agent_name.split('.', 1)[-1]
        return next((s for s in self._rows if s.key == key), None)

    def active(self) -> list[Source]:
        return [s for s in self._rows if s.status == 'active']

    def registered(self) -> list[Source]:
        """등록부에 buyer 행을 만들 소싱처 — hold 는 뺀다."""
        return [s for s in self._rows if s.status != 'hold']

    def __iter__(self) -> Iterator[Source]:
        return iter(self._rows)

    def __len__(self) -> int:
        return len(self._rows)


@lru_cache(maxsize=1)
def default_sources() -> Sources:
    """기본 설치 위치(samba-agent/sources.yaml)의 표. 에이전트 모듈이 스크립트 이름을 물을 때 쓴다."""
    return Sources.load(DEFAULT_ROOT)
