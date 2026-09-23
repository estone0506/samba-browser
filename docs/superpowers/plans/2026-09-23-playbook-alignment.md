# 하네스를 앱 플레이북("SAMBA 주문 처리") 기준으로 맞추기 (2026-09-23)

플레이북 원문: `src/shared/playbook.ts`(builtin.samba.unfulfilled). 하네스 규칙·코드가 이 문서를 따른다. 사용자 결정(2026-09-23):
- 고객 전화번호는 어디에도 입력하지 않는다. 배송 연락처는 **키마스터 신원정보**(앱 `fill_secret` itemType=identity, field=identity.phone) — 하네스는 번호를 보지 않는다. `.env` 연락처(SAMBA_SHIP_PHONE)·삼바웨이브 contact_phone 은 쓰지 않는다(제거).
- ABC마트·그랜드스테이지는 항상 까대기(사무실 수령).
- 플레이북 §4: **까대기면 계정 기본 배송지(사무실)를 유지하고 수정하지 않는다** → 하네스는 배송지 스크립트를 부르지 않고, 주문서 수령인·주소가 비어 있지 않은지만 확인한다.
- 수집 제외 플래그(가격X·재고X·구매보류·다른 작업자)는 **오류일 수 있으니 제외하지 않는다** — 접수·구매는 진행하고 **결제 승인 요약에 플래그를 표시**해 사람이 결제 단계에서 검토한다.

## Global Constraints
- 개인정보(이름·전화·주소)는 state·payload·로그·슬랙·LangSmith 에 남지 않는다. 전화번호는 하네스가 아예 받지 않는다.
- 비밀은 `.env` 에만. 테스트는 `load_settings(env_file=None)` + respx/가짜.
- 한국어 주석, 단따옴표, ruff format/check, 새 로직마다 테스트. 전체 `uv run pytest tests -q` 통과(현재 492).

## Task P1: 규칙 파일을 플레이북 절별로 다시 쓴다
- `samba-agent/rules/buyer_default.md`: §1 대상 선정(제외 조건은 "플래그 표시 후 사람 검토"로), §2 재고 판정, §3 계정·혜택·원가 공식(원가 = 실제 결제액 − 후기 제외 신규 적립 + 사용 적립금 + 미포함 배송비; 마진율 = (정산금 − 원가) ÷ 매출 × 100, 정산금을 모르면 판매가 기준 근사치라고 명시), §4 주문서(옵션 동일·추천상품 금지·까대기는 배송지 유지·직배는 이름·주소 고객 + 전화는 신원정보·배송 요청사항 고객메모).
- 소싱처별 `buyer_<key>.md` 는 default 를 잇고 사이트 특이점만.
- `payer.md`: §5(결제 직전 SAMBA 재조회, 사람 확인, 팝업 종료·잔액만으로 성공 판정 금지, 누가 결제했는지), `recorder.md`: §6(계정 → 소싱주문번호 → 배송비·메모 → 실구매가 마지막 → 플래그 → 재검색), `verifier.md`: §6-6 재검색 대조, 실패 §7 을 각 파일 끝에.
- 규칙 파일 텍스트가 실제 코드 동작과 다르면 코드 쪽 설명을 맞춘다(문서만 앞서가지 않기).

## Task P2: 코드 반영
1. `OrderRef.flags: tuple[str, ...] = ()` — 삼바웨이브 `action_tag` 토큰(콤마 분리, 소문자). `wave.to_order_ref` 가 채운다.
2. 배송지(`agents/buyer.py`):
   - `order_type_of(order) == 'kkadaegi'` → `<key>_set_shipping` 을 **부르지 않는다**. 대신 스냅샷의 `shipping`(있으면) 또는 `get_page` 로 주문서에 수령인·주소가 채워져 있는지만 확인(빈 값이면 needs_human '기본 배송지 없음'). note 는 "사무실 수령(기본 배송지 유지)".
   - direct/gift → 삼바웨이브 상세의 배송지에서 **name·address·address_detail·postal_code 만** 스크립트 인자로 넘긴다(phone 키 자체를 넣지 않는다). 스크립트 결과에 `phone_field_id`(정수) 가 오면 `fill_secret(elementId=…, itemType='identity', field='identity.phone')` 를 부른다 — 결과가 'ok' 로 시작하지 않으면 needs_human. `phone_field_ids`(3칸 사이트)가 오면 needs_human('전화 3칸 사이트 — 앱 부분 입력 미지원'). 둘 다 없으면 needs_human('전화 칸을 찾지 못함').
   - 되읽기 대조는 name·address 만(`SHIPPING_FIELDS` 에서 phone 제거).
   - `BUYER_TOOLS` 에 `fill_secret` 추가(dry-run 에서도 허용 — 결제 비밀이 아니라 배송 연락처).
   - factory `_shipping_provider`: `ship_phone`·`contact_phone` 로직 제거. 반환 사전에 phone 없음. 까대기 요청/불일치 검사는 유지(`order_type` 파라미터 전달).
   - `settings.ship_phone`, `WaveOrderDetail.contact_phone` 제거, `__main__` 배선 정리.
3. 결제 직전 재조회(`agents/payer.py`): wave 가 있으면 결제창 진입 전 `wave.get_order(order_no)` 로 `sourcing_order_number` 가 이미 있으면 `fail(duplicate)`, `status` 가 pending 이 아니면 needs_human('상태 변경: …'). wave 가 없으면 건너뛴다(기존 동작).
4. 승인 요약(`supervisor/approval.py`): `flags` 가 있으면 요약 첫 줄에 `⚠ 플래그: 가격X, 재고X …`(토큰 → 한글 표시: price_x→가격X, stock_x→재고X, hold→구매보류, staff_a/staff_b→담당 A/B, kkadaegi→까대기, jikbae→직배, gift→선물; 모르는 토큰은 그대로).
5. 기록(`agents/recorder.py`, wave 경로): `notes` 에 `계정 {account} · 수단 {card} · 실결제 {paid} · 원가 {cost}` 한 줄을 넣는다(개인정보 없음). 마진 미달로 끝난 건은 기록하지 않는다(사람 검토).
6. 마진(`buyer.py`): `OrderRef.revenue: float = 0`(정산금, 삼바웨이브 `revenue` 가 있으면), 있으면 마진율 = (revenue − cost)/sale_price×100, 없으면 (sale_price − cost)/sale_price 근사치로 note 에 "정산금 미확인 근사".
7. 자동 수집(`queue/intake.py`): 플래그로 제외하지 않는다(현재 동작 유지). 접수 슬랙 한 줄에 플래그가 있으면 덧붙인다.

## Task P3(컨트롤러): 앱 배송지 스크립트 4종 계약 변경
`<key>_set_shipping`: `phone` 인자가 없으면 전화 칸을 채우지 않고 `phone_field_id`(단일 칸) 또는 `phone_field_ids`(3칸)를 반환. 이름·주소는 기존대로.
