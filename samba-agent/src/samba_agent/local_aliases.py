"""저장소의 가명 ↔ 이 PC 의 실제 값.

저장소(공개)에는 계정 아이디·사무실 수령인·주소를 가명으로만 적는다. 실제 값은 이 PC 의
`samba-agent/local-aliases.json`(커밋하지 않는다)에 {가명: 실제 값} 으로 두고, 하네스가 설정·규칙을
읽을 때 가명을 실제 값으로 바꾼다. 파일이 없으면 아무것도 바꾸지 않는다.

    {"buyer01": "실제계정", "김사무": "실제 수령인", "사무실길": "실제 도로명"}

스크립트 묶음을 내보낼 때는 반대로(실제 값 → 가명) 바꿔 저장소에 실제 값이 들어가지 않게 한다.
"""

import json
import os
import sys
from pathlib import Path

ALIASES_FILE = 'local-aliases.json'
_ROOT = Path(__file__).resolve().parents[2]


def _load() -> dict[str, str]:
    # 테스트는 가명 그대로 돈다 — 이 PC 의 실제 값에 물들지 않게 읽지 않는다
    if 'pytest' in sys.modules or os.environ.get('SAMBA_LOCAL_ALIASES', '').lower() == 'off':
        return {}
    path = Path(os.environ.get('SAMBA_LOCAL_ALIASES') or _ROOT / ALIASES_FILE)
    try:
        raw = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {str(k): str(v) for k, v in raw.items() if k and v}


_ALIASES = _load()


def replace_all(text: str, pairs: dict[str, str]) -> str:
    """긴 열쇠부터 바꾼다 — 짧은 열쇠가 긴 열쇠의 일부를 먼저 바꾸지 않게."""
    for key in sorted(pairs, key=len, reverse=True):
        text = text.replace(key, pairs[key])
    return text


def apply(text: str) -> str:
    """가명 → 실제 값(읽을 때)."""
    return replace_all(text, _ALIASES) if _ALIASES else text


def conceal(text: str) -> str:
    """실제 값 → 가명(저장소로 내보낼 때)."""
    return replace_all(text, {v: k for k, v in _ALIASES.items()}) if _ALIASES else text
