# SAMBA Browser (삼바브라우저)

사람이 하는 웹 작업(로그인·인증·결제 포함)을 AI가 대신 끝내주는 Chromium 기반 데스크톱 브라우저

## 현재 상태

**MVP 1단계**: 브라우저 뼈대 + AI 채팅

## 빠른 시작

```bash
corepack enable
pnpm install
pnpm dev
```

## 문서

- **[PRD](docs/PRD.md)** — 제품 요구사항
- **[기술스택](docs/기술스택.md)** — 사용 기술 및 라이브러리
- **[실행방법](docs/실행방법.md)** — 초보자용 설치 및 실행 가이드
- **[구현 계획](docs/superpowers/plans/2026-09-18-mvp-stage1-browser-shell.md)** — MVP 1단계 구현 계획
- **[Aside 검토](docs/reference/aside-검토.md)** — 아키텍처 리뷰
- **[목업](docs/mockups/)** — UI/UX 디자인 참고자료

## 개발 환경 설정

이 프로젝트는 다음 기술 스택을 사용합니다:

- **Electron** — 데스크톱 애플리케이션 프레임워크
- **React 19** + **TypeScript** — UI 개발
- **Tailwind CSS** — 스타일링
- **shadcn/ui** — UI 컴포넌트
- **Zustand** — 상태 관리
- **Claude Agent SDK** — AI 기능 (Claude 구독 로그인 연결. `ANTHROPIC_API_KEY` 가 있으면 그것을 우선 사용)

자세한 기술 스택 정보는 [기술스택](docs/기술스택.md)을 참고하세요.

## 알려진 한계 (MVP 1단계)

- **확인 게이트는 `click` / `type` 도구에만 적용됩니다.** AI 가 `navigate` 로 위험한 URL 에
  직접 이동하거나 `select` 로 옵션을 고르는 경우는 확인을 거치지 않습니다 (2단계에서 확장).
- 탭이 열 수 있는 주소는 `http`/`https`/`about:blank` 뿐입니다. `file:`·`javascript:`·`data:` 는 차단됩니다.
- 작업당 도구 호출 상한은 40회이며 `done` 호출은 상한에 포함되지 않습니다.
- Windows 전용으로 검증했습니다. macOS/Linux 는 1단계 범위 밖입니다.
- `mailto:`/`tel:` 등 외부 스킴 링크는 1단계에서 차단만 하고 로그만 남깁니다.
- 영문 위험 단어 판정은 부분 일치라 오탐이 발생할 수 있습니다(단어 경계 판정은 2단계).

## IDE 추천

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)
