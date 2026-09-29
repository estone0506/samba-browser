# 구매 에이전트 — SSG닷컴

공통 규칙([buyer_default.md](buyer_default.md))을 잇는다. 여기에는 이 소싱처만의
차이만 적는다.

## 이 소싱처만의 차이
- 저장 스크립트 이름: `ssg_product_snapshot` · `ssg_set_shipping` · `checkout_enter_ssg`
- 스크립트는 확장앱 `samba-wave/extension/content-purchase-ssg-order.js` 의 셀렉터·순서를 옮겨 만든다(계획 Task E).
- 스크립트가 아직 없는 동안에는 구매를 시작하지 않고 사람에게 넘긴다.
