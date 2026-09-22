# 하네스 브릿지

SAMBA Browser 의 에이전트 도구를 로컬 HTTP 로 연다. 밖의 LangGraph 하네스(감독자·전문 에이전트)가 손발로 쓴다.

- 켜기: 설정 → 동작 → 하네스 브릿지. 포트 기본 47811, 토큰은 켤 때 자동 생성(복사 버튼, 새로 만들기).
- 바인딩: 127.0.0.1 만. 외부 접근 불가.
- 인증: 헤더 `X-Samba-Token`. 없거나 틀리면 401.

## 규약

- `GET /health` → `{ ok, tools[] }`
- `POST /tool/{name}` 본문 `{ "args": {...} }` → `{ ok, result, steps[] }`
  - `result` 는 채팅 AI 가 보는 것과 같은 도구 본문 문자열
  - `steps` 는 그 호출이 남긴 진행 로그(라벨·성공 여부)
- 오류: 401 토큰 / 404 없는 도구 / 400 JSON 아님·본문 오류 / 409 채팅 실행 중·다른 호출 중 / 504 90초 초과 / 413 본문 1MB 초과 / 500 도구 오류
- 제한 시간을 넘긴 호출은 504 로 답한 뒤에도 끝날 때까지 지켜보고, 그동안 새 호출은 409 다.

## 도구 이름

채팅 AI 와 동일: get_page, find_elements, screenshot, ocr, navigate, click, type, select, scroll,
dismiss_overlay, run_js, wait, new_tab, list_tabs, switch_tab, close_tab, list_accounts,
fill_secret, login, progress, remember_site, save_script, run_script, list_playbooks, update_playbook,
phone_*(폰 연결 시), phone_approve_payment(결제 배선 시). `done` 은 없다.

## 하네스 .env

```
SAMBA_BRIDGE_URL=http://127.0.0.1:47811
SAMBA_BRIDGE_TOKEN=<설정 카드에서 복사한 토큰>
```

## 주의

- 브릿지 호출 중에는 채팅창 AI 실행이 거부된다(한 손발). 반대도 같다.
- 확인 카드는 뜨지 않는다(판단은 하네스가 한다). 캡차·2단계 인증은 도구가 `needs_user` 문자열을 돌려주니 하네스가 사람에게 넘긴다.
- 응답에 비밀값(비밀번호·키패드 값)은 없다 — 도구가 애초에 돌려주지 않는다.
- **브릿지를 켜면, 토큰을 쥔 하네스는 설정의 권한 모드(읽기 전용/가드/전체)와 무관하게 항상 전체 권한으로 동작한다.** 확인 카드가 뜨지 않으므로 클릭·입력·로그인·결제 비밀번호 입력까지 사람 개입 없이 그대로 실행된다. 토큰이 새어나가면 곧 이 PC 전체 권한이 새어나가는 것과 같다 — 토큰 보관에 주의한다. 설정의 권한 모드가 읽기 전용이면 브릿지 세션 자체를 열 수 없다(`createToolSession` 이 거부한다).

## 확인(curl)

```
curl -s -H "X-Samba-Token: <토큰>" http://127.0.0.1:47811/health
curl -s -X POST -H "X-Samba-Token: <토큰>" -H "content-type: application/json" -d "{\"args\":{}}" http://127.0.0.1:47811/tool/list_tabs
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:47811/health   # 401
```
