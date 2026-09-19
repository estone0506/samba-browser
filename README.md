# SAMBA Browser (삼바브라우저)

사람이 하는 웹 작업(로그인·인증·결제 포함)을 AI가 대신 끝내주는 Chromium 기반 데스크톱 브라우저

## 현재 상태

**3단계 마무리 중**: 1단계 `v0.1.0-mvp1` · 2단계 `v0.2.0-mvp2`(키마스터·가져오기·자동 로그인) · 2b `v0.3.0-mvp2b`(Supabase 계정·다기기 동기화·작업공간·AI 연결·확장·채팅 기록) · 3단계(`feature/stage3-phone`: 폰 연동·AI 연결 재작업·제스처·번역·캡처)

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
- **[구현 계획 1단계](docs/superpowers/plans/2026-09-18-mvp-stage1-browser-shell.md)** / **[2단계](docs/superpowers/plans/2026-09-18-stage2-vault-import.md)**
- **[검수 기록](docs/검수/)** — 단계별 실검수 결과
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

## 2단계에서 추가된 것
- **키마스터**: 로그인·결제 비밀번호·카드·신분증 등 6종 항목을 마스터 비밀번호로 암호화 저장(argon2id + AES-256-GCM). AI 는 값을 보지 못하고 `login`/`fill_secret` 도구로 채우기만 한다
- **가져오기**: 크롬·웨일·엣지·Bitwarden 등 비밀번호 CSV, 북마크 HTML
- **자동 로그인**: 로그인창 아이디 칸에 계정 목록 드롭리스트, AI 로그인(알려진 로그인 URL·로그인 링크 폴백, 2단계 로그인, 캡차는 `screenshot`/`ocr` 도구), 로그인 성공 시 바뀐 비밀번호 자동 갱신
- **로컬 OCR**: PP-OCRv5 한국어 ONNX(첫 사용 시 약 18MB 다운로드), 설정에서 끌 수 있음
- **자체 새 탭 페이지** `samba://newtab`, 홈 버튼·홈 주소 설정, 북마크 관리자

## 2b 단계에서 추가된 것
- **계정·동기화**: Supabase 로그인(이메일/구글), 설정·계정·키마스터(암호문만)·북마크·채팅이 PC 사이에서 동기화. 충돌은 마지막 수정 우선, 북마크는 합집합, 삭제는 30일 표식
- **작업공간**: `Ctrl+Alt+1~9` 로 전환, 북마크·키마스터가 작업공간별로 분리
- **AI 연결 설정**: Claude 구독 / 내 API 키 / 서비스 크레딧(예정) + 작업별 모델
- **확장**: 크롬 웹스토어 설치, 크롬·웨일·엣지에서 가져오기, 폴더 불러오기
- **캡차·2FA 넘김**: AI 가 캡차를 만나면 멈추고 사용자가 처리하면 자동 재개(AI 가 대신 풀지 않음)

### 알려진 한계 (2b)
- Realtime 은 환경(회사망·프록시)에 따라 동작하지 않을 수 있고 그때는 60초 폴링으로만 동기화
- 구글 로그인은 127.0.0.1 루프백 콜백을 쓰므로 Supabase Redirect URLs 에 `http://127.0.0.1:47612~47614/callback` 등록 필요
- 확장은 Electron 제약으로 MV3 일부 API 미지원, 자동 업데이트 없음
- 복구 키는 이 PC 에만 보관(다른 PC 에서의 복구는 다음 단계)
- 채팅 본문은 서버에 평문 저장(행 단위 접근 제어·TLS 로만 보호)

## 3단계에서 추가된 것
- **폰 연동(Pro)**: 안드로이드 폰을 USB(adb)로 연결해 문자 인증번호 자동 읽기, ARS 감시, 페이코·토스 결제 승인. 결제 비밀번호는 사용자가 앱 안 폰 화면에 직접 입력(AI·로그에 흐르지 않음). adb·scrcpy 는 폰 화면에서 원클릭 설치
- **AI 연결**: Claude 구독 / Codex 구독 / 내 API 키를 명시적으로 연결·해지, 채팅 입력줄에서 모델(Fable 5.1·Opus 5·Sonnet 5·Haiku 4.5 / GPT-5.6 계열)과 추론 강도 선택, 권한 모드(읽기 전용·보호·전체)
- **화면**: 왼쪽 사이드바·오른쪽 AI 패널 접기와 폭 조절, 작업표시줄 로고·탭 제목
- **마우스 제스처**: 오른쪽 버튼 드래그(웨일 기본 16종, 설정에서 변경)
- **번역**: 페이지 번역(보이는 부분부터, 진행률 표시, 자동 번역 도메인)과 이미지 번역(우클릭)
- **캡처**: 이미지(직접 지정·영역·전체 페이지·전체 화면)와 영상(직접 지정·전체 화면), `Alt+1~6`
- **확장**: 크롬 웹스토어 탭에서 "Chrome에 추가" 를 누르면 그대로 설치, 퍼즐 메뉴에서 켜기/끄기·고정
- **설정 정리**: 동작·모양·AI·계정·보안·일반으로 재편, 사용하지 않는 메뉴 제거

### 알려진 한계 (3단계)
- 폰 연동은 USB 케이블 연결만 지원(무선 adb 는 다음 단계), Pro 요금제 게이트는 개발 중 `SAMBA_PHONE_PRO_OVERRIDE=1` 로 우회(배포판에서는 무시)
- 번역은 AI 연결 경로(Claude CLI)를 쓰므로 첫 배치가 10초 안팎 걸리고, Codex 구독만 연결한 경우 번역이 되지 않음
- 확장은 Electron 지원 범위(chrome.action·서비스 워커 일부) 안에서만 동작
- 모바일 모드는 터치 에뮬레이션을 켜지 않는다(우클릭 제스처와 충돌) — UA·뷰포트만 모바일

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
