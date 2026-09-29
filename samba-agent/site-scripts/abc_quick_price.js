// ABC마트·그랜드스테이지 계정별 빠른 가격 — 상품 페이지의 '최대 혜택가'(그 계정 쿠폰·멤버십 등급 할인 반영)와
// '구매 적립'(후기 적립 제외)만 읽는다. 주문서를 만들지 않는다(2026-09-26 신규, 계정 비교를 몇 초로).
// args: sku(prdtNo·상품 URL), profile, site(선택) · 반환 {my_price, max_reward, list_price, sale_price, logged_in, product_url, note}
const num = s => (s ? parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0 : 0)
const tabIdOf = r => (String(r).match(/tab (\S+)/) || [])[1] || null
const sku = String(args.sku || '').trim()
const prdtNo = (sku.match(/[?&]prdtNo=(\d+)/) || [])[1] || (/^\d{6,}$/.test(sku) ? sku : null)
if (!prdtNo) return { my_price: null, max_reward: 0, logged_in: null, note: 'no prdtNo in sku' }
const host = /grand/i.test(String(args.site || '')) || /grandstage\./.test(sku) ? 'grandstage.a-rt.com' : 'abcmart.a-rt.com'
const url = `https://${host}/product?prdtNo=${prdtNo}`
const tid = tabIdOf(await tabs.open({ ...(args.profile ? { profile: args.profile } : {}), url }))
if (!tid) return { my_price: null, max_reward: 0, logged_in: null, product_url: url, note: 'tab open failed' }
await tabs.switch(tid)
// 가격 영역이 그려질 때까지(최대 혜택가는 로그인 계정 쿠폰을 불러온 뒤 뜬다)
await page.waitFor(/최대 혜택가\s*[\d,]+|판매\s*종료|일시\s*품절|SOLD OUT/, 8000).catch(() => {})
const tx = ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
await tabs.close(tid).catch(() => {})
const loggedIn = /\bLOGOUT\b/.test(tx)
// '99,000원 79,000원 [20%]' — 정가·판매가(할인 없으면 가격 하나)
const head = tx.slice(Math.max(0, tx.indexOf('상품코드 :')))
const pr = head.match(/([\d,]+)원 ([\d,]+)원 \[\d+%\]/) || head.match(/색상코드 : \S+ ([\d,]+)원/)
const list = pr ? num(pr[1]) : null
const sale = pr ? num(pr[2] || pr[1]) : null
const best = tx.match(/최대 혜택가\s*([\d,]+)\s*원/)
const reward = tx.match(/구매 적립\s*([\d,]+)\s*P/)
const ended = /판매\s*종료|판매가 종료|일시\s*품절|SOLD OUT/i.test(tx) && !/바로구매/.test(tx)
return {
  my_price: best ? num(best[1]) : sale,
  max_reward: reward ? num(reward[1]) : 0,
  list_price: list,
  sale_price: sale,
  logged_in: loggedIn,
  sold_out: ended || undefined,
  product_url: url,
  note: !loggedIn ? '로그인 안 됨' : ended ? '판매종료·품절 화면' : best ? null : '최대 혜택가 없음 — 판매가 사용'
}
