// 패션플러스 주문서 정돈 — 쿠폰 최대할인(상품·중복·장바구니)과 보유 적립금 모두 사용(사용자 규칙: 포인트·적립금 항상 사용). 결제 없음.
// 탭: args.tab > 이 레인의 패션플러스 주문서 탭 하나(여럿이면 expect.product_no 로 고르고, 못 고르면 멈춤)
// 쿠폰: '최대할인 적용'이 꺼져 있거나 쿠폰 창의 '총 N원 할인 적용'이 주문서 쿠폰 합보다 크면 창에서 켜고 적용한다
// 반환 {ok,total,coupon,cart_coupon,discount,points_balance,points_used,points_box,points_limit,reward,prepay,order_tab,note}
const OF = /fashionplus\.co\.kr\/order\/\d+(?:[?#]|$)/
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const lines = async q => (await page.get(q ? { selector: q } : {})).tree.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const text = async () => ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const fail = (note, x) => ({ ok: false, note, ...(x || {}) })
const exp = args.expect && typeof args.expect === 'object' ? args.expect : {}
const pnoOf = async () => [...new Set(((await page.get({})).tree.match(/옵션 .+? 수량 \d+개" href=\/goods\/detail\/(\d+)/g) || []).map(m => m.match(/(\d+)$/)[1]))]

let cand = (await tabs.list()).filter(t => OF.test(t.url || '') && (!args.tab || t.id === args.tab))
if (!cand.length) return fail('no order tab')
if (cand.length > 1) {
  const hit = []
  for (const c of cand) { await tabs.switch(c.id); if (exp.product_no && (await pnoOf()).join() === String(exp.product_no)) hit.push(c) }
  if (hit.length !== 1) return fail(`order form ambiguous: ${cand.length} tabs`)
  cand = hit
}
const tab = cand[0].id
await tabs.switch(tab)
await page.waitFor('총 결제 예상금액', 8000)
if (exp.product_no && (await pnoOf()).join() !== String(exp.product_no)) return fail('order form mismatch', { order_tab: tab })

const read = async () => {
  const t = await text()
  return {
    t,
    total: num((t.match(/총 결제 예상금액 \(\d+건\) ([\d,]+)/) || [])[1]),
    coupon: num((t.match(/상품 쿠폰 - ([\d,]+)/) || [])[1]),
    cart_coupon: num((t.match(/장바구니 쿠폰 - ([\d,]+)/) || [])[1]),
    discount: num((t.match(/총 할인금액 - ([\d,]+)/) || [])[1]),
    used: num((t.match(/적립금 사용액 - ([\d,]+)/) || [])[1]),
    balance: num((t.match(/보유 적립금 ([\d,]+)/) || [])[1]),
    reward: num((t.match(/총 예상 적립금 \+ ([\d,]+)/) || [])[1])
  }
}
// 라벨 바로 앞 체크박스 줄
const boxBefore = async lab => {
  const ls = await lines()
  const i = ls.findIndex(l => l.includes(`clickable "${lab}"`))
  return i > 0 && /checkbox/.test(ls[i - 1]) ? { id: parseInt(ls[i - 1].slice(1)), on: /value="on"/.test(ls[i - 1]), label: parseInt(ls[i].slice(1)) } : null
}
let r = await read()
const notes = []

// 1) 쿠폰 — 창을 열어 최대할인 합계를 읽고, 주문서 쿠폰 합보다 크거나 최대할인이 꺼져 있으면 적용
const open = await page.idOf('쿠폰 선택')
if (open >= 0) {
  await page.click(open)
  await sleep(900)
  let mx = await boxBefore('최대할인 적용')
  if (mx && !mx.on) { await page.click(mx.label); await sleep(900); mx = await boxBefore('최대할인 적용') }
  const al = (await lines()).find(l => /button "총 ([\d,]+)원 할인 적용"/.test(l))
  const best = al ? num(al.match(/총 ([\d,]+)원/)[1]) : null
  if (al && (best > r.coupon + r.cart_coupon || (mx && !mx.on))) { await page.click(parseInt(al.slice(1))); await sleep(1200); notes.push(`쿠폰 적용 ${best}`) }
  else {
    const ids = (await lines()).filter(l => /button "모달 닫기"/.test(l)).map(l => parseInt(l.slice(1)))
    for (const id of ids) { try { await page.click(id) } catch (e) {} }
    await sleep(400)
  }
  r = await read()
  if (best != null && best > r.coupon + r.cart_coupon) return fail(`coupon not applied: best ${best} > applied ${r.coupon + r.cart_coupon}`, { order_tab: tab })
  if (mx && !mx.on) notes.push('최대할인 적용 체크 못함')
} else notes.push('쿠폰 선택 버튼 없음')

// 2) 적립금 모두 사용
let limit = r.balance
if (r.balance > 0) {
  const pb = await boxBefore('적립금 모두사용')
  if (!pb) return fail('points checkbox not found', { order_tab: tab, points_balance: r.balance })
  if (!pb.on) { await page.click(pb.label); await sleep(1000) }
  const ls = await lines()
  const box = ls[ls.findIndex(l => l.includes('clickable "적립금 모두사용"')) + 1] || ''
  const ap = parseInt((ls.find(l => /button "적용"$/.test(l)) || '[-1]').slice(1))
  r = await read()
  if (r.used === 0 && ap >= 0) { await page.click(ap); await sleep(1000); r = await read() }
  limit = Math.max(r.used, /textbox/.test(box) ? num((box.match(/value="(\d+)"/) || [])[1]) : 0)
  if (r.used === 0) return fail('points not applied', { order_tab: tab, points_balance: r.balance })
}
return {
  ok: r.total > 0 || (r.total === 0 && r.used > 0),
  total: r.total,
  coupon: r.coupon,
  cart_coupon: r.cart_coupon,
  discount: r.discount,
  points_balance: r.balance,
  points_used: r.used,
  points_box: r.used,
  points_limit: limit,
  reward: r.reward,
  prepay: null,
  order_tab: tab,
  note: notes.join('; ') || null
}
