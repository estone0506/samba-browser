"""에이전트 등록부. 새 소싱처는 registry.yaml 에 1행 + 규칙 파일이면 된다(스펙 §4.3)."""

from collections.abc import Mapping
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict

from samba_agent.agents.contracts import OrderRef

# 앱의 createSambaTools 가 내보내는 도구 이름(docs/bridge.md). 여기 없는 이름은 등록부에 못 쓴다
BRIDGE_TOOLS = frozenset(
    {
        'get_page',
        'find_elements',
        'screenshot',
        'ocr',
        'navigate',
        'click',
        'type',
        'select',
        'scroll',
        'dismiss_overlay',
        'run_js',
        'wait',
        'new_tab',
        'list_tabs',
        'switch_tab',
        'close_tab',
        'list_accounts',
        'fill_secret',
        'login',
        'progress',
        'remember_site',
        'save_script',
        'run_script',
        'list_playbooks',
        'update_playbook',
        'phone_tap',
        'phone_type',
        'phone_key',
        'phone_swipe',
        'phone_screenshot',
        'phone_get_screen',
        'phone_approve_payment',
    }
)

AgentKind = Literal['buyer', 'payer', 'recorder', 'verifier']


class AgentSpec(BaseModel):
    """등록부 1행. 모르는 필드(오타)는 조용히 버리지 않고 로딩을 거부한다."""

    model_config = ConfigDict(extra='forbid')

    name: str
    kind: AgentKind
    match: dict[str, str] = {}
    tools: tuple[str, ...]
    rules: str
    prompts: str
    dataset: str
    retry: int = 0


class Registry:
    """registry.yaml 을 읽어 들고 있는 객체. 감독자는 kind 만 알고 이름은 여기서 고른다."""

    def __init__(self, root: Path, specs: list[AgentSpec]) -> None:
        self._root = root
        self._specs = specs
        self._by_name = {s.name: s for s in specs}

    @classmethod
    def load(cls, root: Path) -> 'Registry':
        raw = yaml.safe_load((root / 'registry.yaml').read_text(encoding='utf-8')) or {}
        specs = [AgentSpec.model_validate(row) for row in raw.get('agents', [])]
        for s in specs:
            bad = sorted(set(s.tools) - BRIDGE_TOOLS)
            if bad:
                raise ValueError(f'{s.name}: 브릿지에 없는 도구 {bad}')
            if not (root / s.rules).exists():
                raise ValueError(f'{s.name}: 규칙 파일이 없다 {s.rules}')
        return cls(root, specs)

    def of_kind(self, kind: str) -> list[AgentSpec]:
        return [s for s in self._specs if s.kind == kind]

    def pick(self, kind: str, order: OrderRef, options: Mapping[str, str]) -> AgentSpec | None:
        """담당 조건이 맞는 첫 에이전트. 없으면 None → 감독자가 needs_human(unsupported)."""
        fields = {'source': order.source, 'seller': order.seller, **dict(options)}
        for s in self.of_kind(kind):
            if all(fields.get(k) == v for k, v in s.match.items()):
                return s
        return None

    def rules_text(self, spec: AgentSpec) -> str:
        return (self._root / spec.rules).read_text(encoding='utf-8')

    def names(self) -> list[str]:
        return [s.name for s in self._specs]

    def __getitem__(self, name: str) -> AgentSpec:
        return self._by_name[name]
