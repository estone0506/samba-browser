// H몰 주문서 정돈(2026-09-27): 열린 주문서(/mo/oda/order)에서 '최대 할인'(쿠폰·깜짝할인·제휴할인 자동 최대)을 켜고
// 포인트(H.Point·적립금)를 규칙대로 넣는다. 결제 없음.
// 사용자 규칙(2026-09-27) 'keep_card_discount'(기본): 카드 즉시할인(롯데 5%)의 기준금액(5만원 이상)이 유지되는 선까지만 쓴다 —
//  사용량 = min(보유, 결제예정액 − 기준금액), 음수면 0. 적립금 먼저, 모자라면 H.Point. 넣은 뒤 즉시할인 줄이 사라지면 줄여 다시 본다.
//  그 카드의 즉시할인이 이 상품에 없으면 기준이 없다 — 최대 사용.
// 인자 {profile?, tab?, points?: 'keep_card_discount'|'max'|'none', card?: '롯데카드', card_min?: 기준금액(원, 없으면 화면 글자·5만원)}
// 반환 {ok, mode, total, base, card_min, points_used, hpoint_used, cash_used, points_balance, reward, coupon, cart_coupon, discount,
//  card_discounts:[{card,rate,cost}], card_kept, order_tab, note}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const OF = /hmall\.com\/mo\/oda\/order/
const tree = async () => { for (let i = 0; i < 4; i++) { try { const g = await page.get({}); if (g && g.tree) return g.tree } catch (e) {} await sleep(500) } return '' }
const els = t => t.split('PAGE TEXT')[0].split('\n').map(l => l.match(/^\[(\d+)\] (\S+)(?: "([^"]*)")?(.*)$/)).filter(Boolean).map(m => ({ id: +m[1], role: m[2], t: nz(m[3]), rest: m[4] }))
const mode = ['max', 'none'].includes(args.points) ? args.points : 'keep_card_discount'
const card = nz(args.card || '롯데카드')
const R = { ok: false, mode, total: null, base: null, card_min: null, points_used: 0, hpoint_used: 0, cash_used: 0, points_balance: null, reward: 0, coupon: 0, cart_coupon: 0, card_kept: null, order_tab: null, note: null }
let c = (await tabs.list()).filter(x => OF.test(x.url || ''))
if (args.tab) c = c.filter(x => x.id === args.tab)
if (c.length !== 1) return { ...R, note: c.length ? 'order form ambiguous: ' + c.length : 'no order tab' }
await tabs.switch(c[0].id)
R.order_tab = c[0].id
await page.waitFor(/총 결제금액/, 8000)
const read = async () => {
  const tr = await tree()
  const t = nz(tr.split('PAGE TEXT:')[1])
  const E = els(tr)
  const bx = E.filter(e => e.role === 'textbox' && /name=useGcAmt/.test(e.rest))
  const items = [...t.matchAll(/상품정보 (.+?) (\S+) \| (\d+)개 ([\d,]+)원/g)]
  return {
    t, E, bx, vals: bx.map(e => num((e.rest.match(/value="([^"]*)"/) || [])[1])),
    items: items.reduce((a, m) => a + num(m[4]), 0),
    total: num((t.match(/총 결제금액 (?:\d+% )?([\d,]+) ?원/) || [])[1]),
    discount: num((t.match(/최대 할인 -([\d,]+)원/) || [])[1]),
    ship: num((t.match(/배송비 \+?([\d,]+)원/) || [])[1]),
    reward: num((t.match(/([\d,]+)P 적립/) || [])[1]),
    hp: num((t.match(/H\.Point \(([\d,]+)\)/) || [])[1]),
    cash: num((t.match(/적립금 \(([\d,]+)\)/) || [])[1]),
    cards: [...t.matchAll(/(\S+) (\d+)% 즉시할인 ([\d,]+)원/g)].map(m => ({ card: m[1] + '카드', rate: +m[2], cost: num(m[3]) }))
  }
}
let s = await read()
if (!s.total) return { ...R, note: 'total not found (주문서 아님?)' }
if (s.bx.length !== 2) return { ...R, note: 'point boxes ' + s.bx.length }
// 최대 할인 스위치 — 꺼져 있으면 켠다
const sw = s.E.find(e => e.role === 'switch' && e.t === '최대 할인')
if (sw && /value="off"/.test(sw.rest)) { await page.click(sw.id); await sleep(1500); s = await read() }
// 칸 [0] H.Point · [1] 적립금 — 값을 넣고 다시 읽는다(번호는 읽을 때마다 새로)
const put = async (k, v) => {
  const b = (await read()).bx[k]
  if (!b) return false
  await page.type(b.id, String(v), false)
  await sleep(1500)
  return true
}
const setPts = async (cash, hp) => { await put(1, cash); await put(0, hp); s = await read() }
const mine = x => x.card === card || x.card.replace(/카드$/, '') === card.replace(/카드$/, '')
if (mode === 'max') {
  for (let k = 0; k < 2; k++) {
    const b = (await read()).E.filter(e => e.role === 'button' && (e.t === '전액사용' || e.t === '전액취소'))[k]
    if (b && b.t === '전액사용' && (k ? s.cash : s.hp) > 0) { await page.click(b.id); await sleep(1800) }
  }
  s = await read()
} else {
  // 먼저 0 으로 — 결제예정액(포인트 전) 기준을 잡는다
  if (s.vals.some(v => v > 0)) await setPts(0, 0)
  if (s.vals.some(v => v > 0)) return { ...R, note: 'points not cleared: ' + s.vals.join('/') }
  // 결제예정액(카드 즉시할인 전) = 상품 합계 − 최대 할인 + 배송비. 즉시할인이 아직 안 붙었으면 총액과 같아야 한다
  const base = s.items - s.discount + s.ship
  const applied = /\d+% 즉시할인이 적용/.test(s.t)
  if (!applied && base !== s.total) return { ...R, note: `base ${base} != total ${s.total}` }
  R.base = base
  if (mode === 'keep_card_discount') {
    const has = s.cards.some(mine)
    // 기준금액: 인자 > 화면 글자 > 5만원(2026-09-27 롯데 5% 행사). 주문서엔 안 보이고, 상품 페이지 안내는 누르면 할인이 바뀐다
    const min = has ? Math.max(0, Math.round(Number(args.card_min) || num((s.t.match(/기준금액 ([\d,]+)만원/) || [])[1]) * 10000 || 50000)) : 0
    R.card_min = min
    const apply = async u => { const cu = Math.min(s.cash, u); await setPts(cu, u - cu); return !has || s.cards.some(mine) }
    // 사용량 = min(보유, 결제예정액 − 기준금액). 넣은 뒤 즉시할인 줄이 사라지면(기준금액이 더 높다) 1,000원 단위로 줄여 찾는다
    let hi = Math.max(0, Math.min(s.hp + s.cash, base - min))
    R.card_kept = hi === 0 || (await apply(hi))
    if (!R.card_kept) {
      let lo = 0
      for (let i = 0; i < 7 && hi - lo > 1000; i++) { const mid = Math.floor((lo + hi) / 2000) * 1000; if (await apply(mid)) lo = mid; else hi = mid }
      R.card_kept = await apply(lo)
      R.note = `기준금액 ${min} 로는 즉시할인이 사라져 ${lo} 까지만 사용`
    }
  }
}
R.cash_used = s.vals[1] || 0
R.hpoint_used = s.vals[0] || 0
R.points_used = R.hpoint_used + R.cash_used
R.points_balance = s.hp + s.cash
R.total = s.total
R.reward = s.reward
R.discount = R.coupon = s.discount
R.card_discounts = s.cards
R.affiliate_off = /바로접속 OFF/.test(s.t)
if (mode === 'keep_card_discount') {
  R.ok = R.card_kept !== false && R.total > 0
  if (!R.ok) R.note = `card discount lost (use ${R.points_used}, total ${R.total})`
} else if (mode === 'max') {
  R.ok = (s.hp > 0 ? R.hpoint_used > 0 : true) && (s.cash > 0 ? R.cash_used > 0 : true) && (R.total > 0 || R.points_used > 0)
  if (!R.ok) R.note = `points not applied: hp ${R.hpoint_used}/${s.hp}, cash ${R.cash_used}/${s.cash}`
} else R.ok = R.points_used === 0 && R.total > 0
return R
