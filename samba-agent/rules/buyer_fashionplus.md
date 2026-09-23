# 구매 에이전트 — 패션플러스

공통 규칙은 [rules/buyer_default.md](buyer_default.md) 를 그대로 따른다. 여기에는 이 소싱처만의
차이만 적는다.

## 이 소싱처만의 차이
- 저장 스크립트 이름: `fashionplus_product_snapshot` · `fashionplus_set_shipping` · `checkout_enter_fashionplus`
- 스크립트는 확장앱 `samba-wave/extension/content-purchase-fashionplus-order.js` 의 셀렉터·순서를 옮겨 만든다(계획 Task E).
- 스크립트가 아직 없는 동안에는 구매를 시작하지 않고 사람에게 넘긴다.
