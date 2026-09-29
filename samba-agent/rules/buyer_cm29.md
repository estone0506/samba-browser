# 구매 에이전트 — 29CM

공통 규칙([buyer_default.md](buyer_default.md))을 잇는다. 여기에는 이 소싱처만의 차이만 적는다.

## 이 소싱처만의 차이
- 저장 스크립트 접두어는 `cm29` 다(`cm29_product_snapshot` · `cm29_set_shipping`). 결제창 진입만 `checkout_enter_29cm`.
- 요청 옵션에 "품절" 이 표시되면 품절이다 → fail(out_of_stock).
- 계정별 쿠폰은 계정 탭 프로필마다 따로 본다.
