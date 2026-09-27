# 구매 에이전트 — 패션플러스

공통 규칙([buyer_default.md](buyer_default.md))을 잇는다. 여기에는 이 소싱처만의
차이만 적는다.

## 흐름(2026-09-27)
1. `fashionplus_product_snapshot` — 상품은 원문링크의 `/goods/detail/<상품번호>` 로 연다(sources.yaml product_id).
   옵션을 골라 '바로 구매'로 주문서(`/order/<번호>`)까지 가서 주문서 상품번호·옵션·수량을 되읽는다.
   다르면 `order_form_mismatch` 로 멈춘다. 최근 3일 같은 상품번호·옵션 주문(취소 아님)이 있으면 중복 구매 흔적.
2. `fashionplus_order_prep` — 쿠폰은 '최대할인 적용'(상품·중복·장바구니), 적립금은 '모두사용'으로 전부 쓴다.
   쿠폰 창의 최대 할인 합이 적용 합보다 크거나 적립금이 안 들어가면 ok:false(사람에게).
3. `fashionplus_payment_quotes` — 결제수단은 **네이버페이만**(sources.yaml pay_provider: naver, 사용자 결정
   2026-09-27). 네이버페이 안의 카드는 네이버페이 창에서 고르므로 견적 줄의 card 는 비어 있다.
4. 배송지 — 까대기는 기본 배송지(사무실) 유지. 아니면 `fashionplus_select_shipping` 으로 목록의 같은 배송지를
   고르고, 없을 때만 `fashionplus_set_shipping`(새 주소 입력: 이름·우편번호 찾기·상세주소, 전화 칸은 하네스가
   채운다) → `fashionplus_confirm_shipping`('등록하기'로 반영, 기본 배송지로 설정은 켜지 않는다).
5. `checkout_enter_fashionplus` — 네이버페이·'네이버 카드간편결제'를 고르고 필수 동의 뒤 '주문하기'로 결제창을 연다.
   시험(dryRun)은 '주문하기' 직전에서 멈춘다. 실결제는 expect(상품번호·옵션)·amount·tab 이 없으면 누르지 않고,
   주문서 총액이 amount 를 넘거나 누르기 직전 되읽은 상품·금액이 바뀌면 멈춘다.
6. `fashionplus_order_detail` — `/mypage/order/detail/<주문번호>` 에서 결제금액·적립금 사용·쿠폰을 읽는다.
   적립은 상세에 없다(견적 적립을 쓴다). 카드사도 안 나온다(결제수단 '네이버페이').

## 품절
- 품절 옵션은 선택지 목록에서 **빠진다**. 주문 옵션이 목록에 없다는 것만으로는 품절 확증이 아니다(옵션 대조로 가른다).
- 상품 전체 품절은 선택지 0개 + 상품 정보 영역의 'SOLD OUT' 표시로만 본다 — 스냅샷이 `sold_out: true`·
  `error: 'sold_out'` 으로 알리면 하네스가 스크립트 수리 없이 확정 품절(fail, out_of_stock)로 끝낸다.

## 알려진 막힘
- 새 주소 입력의 '우편번호 찾기' 팝업(카카오 우편번호, 하위 프레임) 안 요소를 앱이 못 찾는다(앱 page-bridge
  버그). 고치기 전에는 `fashionplus_set_shipping` 이 ok:false 로 멈추고 사람에게 넘어간다 — 목록에 있는
  배송지(select_shipping)와 까대기는 영향이 없다.
