// 29CM 계정별 빠른 가격(2026-09-26 신규) — 상품 페이지의 '나의 구매 가능 가격'(그 계정 쿠폰·등급 반영)과
// '구매 적립금 최대'만 읽는다. 주문서를 만들지 않는다(계정당 몇 초). 하네스 _quick_pick 이 my_price − max_reward 로 계정을 고른다.
// 로그아웃 상태에서도 '나의 구매 가능 가격'(첫 구매가)이 보인다 — 머리글 '로그아웃' 버튼으로 로그인 여부를 따로 본다.
// '무신사 삼성카드 결제 시' 가격·적립은 쓰지 않는다(없는 제휴카드).
// args: sku(상품 URL·상품번호), profile
// 반환 {my_price, max_reward, list_price, logged_in, sold_out, product_url, note}
const num = s => s ? parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0 : 0
const sku = String(args.sku || '').trim()
const pno = (sku.match(/(?:catalog|products)\/(\d+)/) || [])[1] || (/^\d{5,}$/.test(sku) ? sku : null)
if (!pno) return { my_price: null, max_reward: 0, list_price: null, logged_in: null, note: 'sku 에 상품번호 없음' }
const product_url = 'https://www.29cm.co.kr/products/' + pno
const o = await tabs.open({ ...(args.profile ? { profile: args.profile } : {}), url: product_url })
const tid = (String(o).match(/tab (\S+)/) || [])[1]
if (!tid) return { my_price: null, max_reward: 0, list_price: null, logged_in: null, product_url, note: 'tab open failed' }
await tabs.switch(tid)
await page.waitFor(/나의 구매 가능 가격|판매 ?종료|품절된 상품/, 8000).catch(() => {})
let t = '', tx = ''
// 가격 칸은 늦게 뜨기도 한다 — 숫자가 보일 때까지 짧게 다시 읽는다
for (let i = 0; i < 8; i++) {
  t = (await page.get({})).tree
  tx = (t.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
  if (/[\d,]+원 나의 구매 가능 가격/.test(tx) || /판매 ?종료|품절된 상품/.test(tx)) break
  await sleep(250)
}
await tabs.close(tid).catch(() => {})
const logged_in = /\] button "(로그아웃|LOGOUT|보유중)"|보유 적립금 사용/i.test(t) ? true : /로그인\/회원가입|\] button "LOGIN"/i.test(t) ? false : null
const my = tx.match(/([\d,]+)원 나의 구매 가능 가격/)
// 정가·판매가: '169,000원 11% 150,580원' 꼴의 첫 가격 묶음. 할인 없으면 첫 'N원'
const pr = tx.match(/([\d,]+)원 \d+% ([\d,]+)원/)
const reward = tx.match(/구매 적립금 최대 ([\d,]+)원/)
const buy = /\] button "바로 ?구매하기"/.test(t)
const sold_out = !buy && /판매 ?종료|품절된 상품|일시 ?품절/.test(tx)
return {
  // 로그인이 확인될 때만 가격을 준다(null 이면 머리글을 못 읽은 것 — 첫 구매가가 비교에 들어가면 안 된다)
  my_price: logged_in !== true ? null : my ? num(my[1]) : pr ? num(pr[2]) : null,
  max_reward: reward ? num(reward[1]) : 0,
  list_price: pr ? num(pr[1]) : null,
  logged_in,
  sold_out,
  product_url,
  note: !logged_in ? '로그인 ' + (logged_in === false ? '안 됨' : '확인 못 함') + ' — 첫 구매가라 비교에 쓰지 않는다' : my ? null : '나의 구매 가능 가격 없음(판매가로 대신)'
}
