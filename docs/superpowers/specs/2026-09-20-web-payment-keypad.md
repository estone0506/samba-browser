# 웹 결제 비밀번호 키패드 입력 (키마스터 값을 앱이 넣는다)

브랜치 `feature/stage3-phone` 최신에서 작업. 폰 쪽 `src/main/phone/pay-secret.ts` 와 같은 규칙.

## 목표
NICE ePAY(`m.niceepay.com … pinCert.do`)·페이코 웹 등 결제 비밀번호 키패드에서, `fill_secret(itemType 'password', provider)` 를 부르면
앱이 키마스터 값을 읽어 숫자 버튼을 눌러 준다. 모델·로그·IPC·onStep 라벨에는 값이 절대 나가지 않는다(자리수만).

## 구현
1. preload op `keypadLayout()`(격리 월드): 보이는 요소 중 텍스트가 한 자리 숫자(0~9)인 button/a/div/span/td → `{ digit, id }[]`.
   0~9 가 각각 정확히 한 개일 때만 배치 반환, 아니면 null(부분·중복 배치로는 누르지 않음). 이미지 키패드는 1차 제외(OCR 없음).
   프레임 안 키패드는 `callEveryFrame` 방식으로 프레임별 시도(프레임 id 인코딩). 입력 자리수 표시(dot)를 셀 수 있으면 `filled`.
2. 메인 `src/main/vault/web-keypad.ts` `enterWebPaymentPassword({ vault, accountId, provider, jobId, tab, pageBridge, confirm })`
   - 항상 `confirm('결제 비밀번호 입력(N자리)', 'danger')` 먼저(권한 모드 무관). 거부 → `'denied'`.
   - `vault.getSecretForFill(accountId, 'password', 'value', jobId, 'ai', provider)` 로 값 읽기. 함수 밖으로 값 미반출.
   - 배치가 완전하면 자리마다 `pageBridge.click(tab, id)`, 200ms 대기. `filled` 로 자리 증가 확인, 안 늘면 `'verify-failed'`(지우기 버튼 있으면 되돌림).
   - 확인/입력완료/결제 버튼은 누르지 않음. 결과 `'ok'|'denied'|'locked'|'not-found'|'ambiguous'|'layout-incomplete'|'verify-failed'`. 시도 1회.
3. `src/main/agent/tools.ts fill_secret`: 키패드 화면(`secret-page.ts`)이면 handoff 대신 실행기 호출. `'ok'` → "N자리 입력됨. 확인 버튼은 사용자 몫". 실패 → 기존 handoff 카드.
4. `prompt.ts` 문구 갱신. 키패드 화면에서 모델의 click/type/screenshot 거부는 유지.
5. 테스트: 배치 파싱(완전/중복/부족), 실행기(거부 시 클릭 0, 정상 6자리 순서, 검증 실패 되돌림, 호출 인자·라벨·반환값에 숫자 값 없음), fill_secret 분기.

## 구현 결과(2026-09-21)
- preload `keypadLayout()`(page-core.ts) → page-bridge `keypadLayout(tab)`·`keypadFilled(tab, frame)` → `src/main/vault/web-keypad.ts` `enterWebPaymentPassword` → `tools.ts fill_secret` 분기(`keypadEnter`).
- 스펙과 다른 점: 확인 카드는 **guard 모드에서만** 1회(full 은 묻지 않는다 — fill_secret 의 평소 규칙과 같다). 계정은 결제창 호스트로 못 찾으면 **팝업을 연 탭(opener) 호스트**로 찾고, 계정 도메인 탭이 연 창이 아니면 넣지 않는다.
- 실패(배치 불완전·검증 실패·금고 잠김)는 넘김 카드(kind 'keypad')로 떨어진다.

## 검증(실기, 사용자)
무신사 주문서 → 무신사머니 → 결제하기 → 머니 결제하기 → NICE ePAY 화면에서 fill_secret(password, site) → 확인 카드 승인 → 6자리 입력됨 → 사용자가 확인 버튼.
