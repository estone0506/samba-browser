# 제3자 소프트웨어 고지 (Third-Party Notices)

SAMBA Browser 는 아래의 오픈소스 소프트웨어·데이터·모델을 포함하거나 함께 배포합니다.
각 항목의 저작권은 해당 권리자에게 있으며, 표기된 라이선스 조건에 따라 사용합니다.

최종 갱신: 2026-09-19 · 대상 버전: 1.0.0

---

## 1. 소스 코드에 직접 포함된 제3자 저작물

우리 저장소의 파일 안에 제3자 코드가 **직접 들어 있는** 항목입니다. 배포본에 라이선스
전문을 함께 실어야 하는 대상이므로 따로 구분합니다.

| 저작물 | 라이선스 | 들어간 위치 | 라이선스 전문 |
|---|---|---|---|
| The Chromium Project — 자동완성·비밀번호 관리자 정규식 상수 (`kEmailRe`, `kNameIgnoredRe`, `kPasswordRe`, `kOneTimePwdRe`, `kSearch`) | BSD-3-Clause | `src/preload/login-detect.ts` | [`resources/licenses/LICENSE-chromium.txt`](resources/licenses/LICENSE-chromium.txt) |
| Apple `password-manager-resources` — 사이트 규칙 데이터(비밀번호 변경 URL, 공용 자격증명 백엔드, 2FA 결합 사이트 등) | MIT | `resources/site-rules/*.json` | [`resources/site-rules/LICENSE-apple-password-manager-resources.md`](resources/site-rules/LICENSE-apple-password-manager-resources.md) |

> **참고 — 로그인 폼 탐지 휴리스틱**
> `src/preload/login-detect.ts` 의 후보 선택·가시성 판정 로직은 SAMBA Browser 의
> 독자 설계입니다(점수 합산 방식). 어떤 비밀번호 관리자 구현에서도 코드를 가져오지
> 않았으며, 웹 표준 `autocomplete` 토큰과 공개된 업계 관행만 참고했습니다.
> 위 표의 Chromium 정규식 상수만이 제3자에서 가져온 부분입니다.

## 2. 실행 시 내려받는 모델

| 저작물 | 라이선스 | 비고 |
|---|---|---|
| PP-OCRv5 (PaddleOCR) ONNX 모델 — det mobile / 한국어 rec mobile | Apache-2.0 | 저장소 [`xberg-io/paddleocr-onnx-models`](https://huggingface.co/xberg-io/paddleocr-onnx-models) 가 Apache-2.0 으로 배포. 앱에 동봉하지 않고 최초 1회 사용자의 PC 로 내려받습니다(`src/main/ocr/engine.ts`). |

## 3. 앱에 함께 배포되는 주요 의존성

`pnpm licenses list` 로 뽑은 결과 중 직접 의존성입니다. 전체 목록은 아래 4장을 보세요.

| 패키지 | 라이선스 |
|---|---|
| electron | MIT |
| electron-builder / electron-vite / @electron-toolkit/* | MIT |
| react, react-dom | MIT |
| radix-ui (@radix-ui/*) | MIT |
| tailwindcss, @tailwindcss/vite, tailwind-merge, tw-animate-css | MIT |
| zustand | MIT |
| zod | MIT |
| i18next, react-i18next | MIT |
| @supabase/supabase-js | MIT |
| onnxruntime-node, onnxruntime-common | MIT |
| adm-zip | MIT |
| sql.js | MIT |
| papaparse | MIT |
| pngjs | MIT |
| node-html-parser | MIT |
| hash-wasm | MIT |
| jsdom, vitest, vite, prettier, eslint (개발 전용) | MIT |
| clsx | MIT |
| drizzle-orm | Apache-2.0 |
| class-variance-authority | Apache-2.0 |
| typescript (개발 전용) | Apache-2.0 |
| lucide-react (아이콘) | ISC |
| **@anthropic-ai/claude-agent-sdk** | **비(非)오픈소스 — Anthropic PBC 상용 약관** |

### ⚠️ 주의가 필요한 항목

- **@anthropic-ai/claude-agent-sdk (+ -win32-x64)**: 오픈소스 라이선스가 아닙니다.
  패키지의 `license` 필드는 `SEE LICENSE IN README.md` 이고, 동봉된 `LICENSE.md` 는
  "© Anthropic PBC. All rights reserved." 와 함께
  <https://code.claude.com/docs/en/legal-and-compliance> 의 약관을 따르도록 합니다.
  유료 SaaS 로 재배포하기 전에 해당 약관의 재배포·상용 이용 조건을 반드시 확인하세요.
- **lightningcss / lightningcss-win32-x64-msvc (MPL-2.0)**: 파일 단위 카피레프트입니다.
  수정 없이 의존성으로만 쓰므로 소스 공개 의무는 발생하지 않지만, 해당 파일을 고치면
  그 파일의 소스를 공개해야 합니다. (tailwindcss 의 하위 의존성)
- **caniuse-lite (CC-BY-4.0)**: 데이터셋입니다. 빌드 타임에만 쓰이며 배포본에
  포함되지 않지만, 포함하게 될 경우 저작자 표시가 필요합니다.
- **GPL / LGPL / AGPL / SSPL 계열은 의존성 트리 전체에 하나도 없습니다.** (2026-09-19 확인)

## 4. 전체 의존성 라이선스 분포

`pnpm licenses list --json` (2026-09-19, lockfile 기준) 집계입니다.

| 라이선스 | 패키지 수 | 성격 |
|---|---|---|
| MIT | 619 | 허용적 |
| ISC | 36 | 허용적 |
| Apache-2.0 | 28 | 허용적(특허 조항) |
| BSD-2-Clause | 21 | 허용적 |
| BSD-3-Clause | 13 | 허용적 |
| BlueOak-1.0.0 | 8 | 허용적 |
| MIT-0 | 2 | 허용적 |
| MPL-2.0 | 2 | 약한 카피레프트(파일 단위) |
| WTFPL, `WTFPL OR ISC`, `WTFPL OR MIT` | 3 | 허용적 |
| Python-2.0 | 1 | 허용적 |
| CC0-1.0, `MIT OR CC0-1.0` | 2 | 퍼블릭 도메인 |
| CC-BY-4.0 | 1 | 저작자 표시 필요(데이터) |
| Unlicense | 1 | 퍼블릭 도메인 |
| 0BSD | 1 | 허용적 |
| 라이선스 미표기(Unknown) | 2 | @anthropic-ai/claude-agent-sdk — 위 주의 참고 |

**GPL-2.0 / GPL-3.0 / LGPL / AGPL-3.0 / SSPL: 0건.**

## 5. 아이콘·이미지 자산

| 자산 | 출처 | 상태 |
|---|---|---|
| `resources/logo.png`, `src/renderer/src/assets/logo.png` | 사용자 제공 SAMBA 로고 | 자체 자산 |
| `resources/icon.png`, `resources/icon.ico` | 위 로고에서 생성한 앱 아이콘 | 자체 자산 |
| `build/icon.png`, `build/icon.ico`, `build/icon.icns` | electron-vite 템플릿 기본 아이콘(Electron 로고)이었음 → SAMBA 로고로 교체 | 교체 완료 |
| UI 아이콘 전체 | `lucide-react` | ISC |
| 타사 브라우저(Aside 등)의 로고·이미지 | — | **없음** (저장소 전체 검사 결과 0건) |

## 6. 라이선스 전문

### MIT License

```
Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### ISC License

```
Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### BSD-3-Clause

Chromium 이 쓰는 형태의 전문은 [`resources/licenses/LICENSE-chromium.txt`](resources/licenses/LICENSE-chromium.txt) 에 있습니다.

### Apache License 2.0

전문: <https://www.apache.org/licenses/LICENSE-2.0>

### Mozilla Public License 2.0

전문: <https://www.mozilla.org/MPL/2.0/>

---

각 패키지의 저작권 표시는 `node_modules/<패키지>/LICENSE` 에 그대로 보존되어 있습니다.
