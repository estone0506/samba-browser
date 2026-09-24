"""저장 스크립트 자가 수리 — 스크립트가 실패하면 AI 가 화면을 보고 고친 스크립트를 만들어 시험하고,
하네스가 결과를 검증한 뒤에만 그 스크립트로 갈아 끼운다(사용자 2026-09-24: 실패로 끝내지 말고 AI 로 이어 가기)."""

from samba_agent.repair.agent import RepairOutcome, ScriptRepairer, blocked_reason
from samba_agent.repair.history import FileScriptSource, ScriptHistory

__all__ = ['FileScriptSource', 'RepairOutcome', 'ScriptHistory', 'ScriptRepairer', 'blocked_reason']
