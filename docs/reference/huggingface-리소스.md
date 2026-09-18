# Hugging Face 리소스 조사 (2026-09-18)

3~5단계(폰 화면 이해·OCR·ARS 음성·로컬 LLM)용 후보. 라이선스·실행환경 기준 우선순위.

## 채택 후보 (우선순위)

| 단계 | 용도 | 1순위 | 보조 | 라이선스 |
|---|---|---|---|---|
| 3 | 폰 스크린샷 → 요소 좌표(GUI grounding) | **Qwen2.5-VL-3B-Instruct-GGUF** (ggml-org/unsloth, 공식 GGUF+mmproj, CPU/저사양 GPU) · Qwen3-VL-2B/8B GGUF | **ShowUI-2B** (GUI 전용, 경량) | Apache-2.0 |
| 3 | SMS 인증번호·보안 키패드 숫자 OCR | **PP-OCRv5 Korean rec + 공용 det (ONNX)** — CPU 실시간 | OnnxTR(docTR) | Apache-2.0 |
| 5 | ARS 한국어 음성 인식 | **ghost613/faster-whisper-large-v3-turbo-korean** (CTranslate2, CPU) | royshilkrot/whisper-large-v3-turbo-korean-ggml (whisper.cpp) | Whisper 라이선스 승계 |
| 4 | 재생 실패 복구용 로컬 LLM | **Qwen2.5-7B / Qwen3-4B GGUF** (Ollama) | Gemma | Apache-2.0 / Gemma |
| 참고 | 웹 에이전트 데이터셋 | Multimodal-Mind2Web (osunlp) — 벤치마크·참고용 | | 연구용(상업 파인튜닝 전 확인) |

## 보안 키패드 처리 방식
OCR 단독으로는 "숫자 값"만 얻음. 키패드 배치는 GUI grounding(Qwen-VL/ShowUI)으로 숫자→좌표를 읽고, **앱이 금고의 비밀번호 자리수대로 좌표를 터치**. 모델은 어떤 숫자를 누르는지 모름.

## 스킵·보류
- UI-TARS-72B, Mind2Web-2: 로컬 PC 과대
- TrOCR: 한국어 미지원
- **EXAONE 3.5**: 한국어 최상급이나 LG 자체 라이선스(상업 SaaS 조건부) → 법무 확인 전 보류
- GUI-Actor(MS), UI-TARS 일부 repo: 라이선스 `other`/연구 표기 → 개별 확인
- 한국어 웹폼/체크아웃 데이터셋: 없음 → 자체 구축(녹화 데이터 활용)

## 전화망 주의
ARS 는 8kHz 협대역이라 Whisper 기본 정확도 저하 가능. 실제 ARS 녹취로 사전 검증 후 필요 시 미세조정.

## 링크
- Qwen2.5-VL-3B GGUF: https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF
- Qwen3-VL-2B GGUF: https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF
- ShowUI-2B: https://huggingface.co/showlab/ShowUI-2B
- PP-OCRv5 Korean: https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec · ONNX: https://huggingface.co/xberg-io/paddleocr-onnx-models
- faster-whisper korean: https://huggingface.co/ghost613/faster-whisper-large-v3-turbo-korean
- whisper korean ggml: https://huggingface.co/royshilkrot/whisper-large-v3-turbo-korean-ggml
- Qwen3-4B GGUF: https://huggingface.co/Qwen/Qwen3-4B-GGUF
- Multimodal-Mind2Web: https://huggingface.co/datasets/osunlp/Multimodal-Mind2Web
