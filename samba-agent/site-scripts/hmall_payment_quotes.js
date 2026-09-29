// H몰 결제수단 견적(2026-09-27): 열린 주문서에서 결제수단을 하나씩 골라 총 결제금액을 읽는다. 결제하기는 누르지 않는다.
// 포인트는 건드리지 않는다(hmall_order_prep 이 정한 사용액 그대로) — 줄마다 points_used 에 그 값을 싣는다.
// 인자 {profile?, tab?, methods?: ['네이버페이','카드',…], cards?: ['롯데카드','현대카드',…]}
// 반환 {ok, quotes:[{method, card, cost, reward, points_used, registered, available, promo}], base_cost, points_used, order_tab, note}
//  - '카드' 줄은 카드사마다 한 줄(롯데 5% 즉시할인 등은 선택 후 총액에 반영된다)
//  - H포인트페이는 등록 카드·계좌가 없으면 registered:false. 페이 프로모션(선착순 적립·혜택)은 promo 글자로만 남긴다(확정 아님)
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const OF = /hmall\.com\/mo\/oda\/order/
const tree = async () => { for (let i = 0; i < 4; i++) { try { const g = await page.get({}); if (g && g.tree) return g.tree } catch (e) {} await sleep(500) } return '' }
const els = t => t.split('PAGE TEXT')[0].split('\n').map(l => l.match(/^\[(\d+)\] (\S+)(?: "([^"]*)")?(.*)$/)).filter(Boolean).map(m => ({ id: +m[1], role: m[2], t: nz(m[3]), rest: m[4] }))
const R = { ok: false, quotes: [], base_cost: null, points_used: 0, order_tab: null, note: null }
let c = (await tabs.list()).filter(x => OF.test(x.url || ''))
if (args.tab) c = c.filter(x => x.id === args.tab)
if (c.length !== 1) return { ...R, note: c.length ? 'order form ambiguous: ' + c.length : 'no order tab' }
await tabs.switch(c[0].id)
R.order_tab = c[0].id
await page.waitFor(/총 결제금액/, 8000)
const read = async () => {
  const tr = await tree(), t = nz(tr.split('PAGE TEXT:')[1]), E = els(tr)
  const boxes = E.filter(e => e.role === 'textbox' && /name=useGcAmt/.test(e.rest)).map(e => num((e.rest.match(/value="([^"]*)"/) || [])[1]))
  return { t, E, total: num((t.match(/총 결제금액 (?:\d+% )?([\d,]+) ?원/) || [])[1]), reward: num((t.match(/([\d,]+)P 적립/) || [])[1]), used: boxes.reduce((a, b) => a + b, 0) }
}
const click = async (pred, wait) => { const s = await read(); const e = s.E.find(pred); if (!e) return false; await page.click(e.id); await sleep(wait || 900); return true }
let s = await read()
if (!s.total && !s.used) return { ...R, note: 'total not found' }
R.base_cost = s.total
R.points_used = s.used
const PAYS = ['H포인트페이', '네이버페이', '카카오페이', '토스페이', '페이코', '삼성페이', '스마일페이']
// 실행 시간 75초 제한 — 기본은 카드·네이버페이·H포인트페이만. 카드는 주문서 즉시할인 줄에 뜬 카드사 + 기준 현대카드
const want = Array.isArray(args.methods) && args.methods.length ? args.methods.map(nz) : ['카드', '네이버페이', 'H포인트페이']
const instCards = [...s.t.matchAll(/(\S+) \d+% 즉시할인 [\d,]+원/g)].map(m => m[1] + '카드')
const cards = Array.isArray(args.cards) && args.cards.length ? args.cards : [...new Set([...instCards, '현대카드'])]
const row = (method, card, st, extra) => ({ method, card, cost: st.total, reward: st.reward, points_used: st.used, registered: true, available: st.total > 0 || st.used > 0, allowed: true, ...(extra || {}) })
for (const m of want) {
  if (/카드/.test(m) && !PAYS.includes(m)) {
    const list = m === '카드' ? cards : [m]
    for (const cd of list) {
      if (!(await click(e => e.role === 'clickable' && e.t === '카드'))) { R.note = 'card tab not found'; break }
      // 카드 고르기 칸: '신용카드 선택', 고른 뒤엔 그 카드 이름('롯데카드' + 글자 '일시불')
      const cur = st0 => (st0.t.match(/휴대폰결제 (\S+) (?:일시불|\d+개월)/) || [])[1] || null
      const st0 = await read()
      const opener = st0.E.find(e => e.role === 'clickable' && (e.t === '신용카드 선택' || (cur(st0) && e.t === cur(st0))))
      if (!opener) { R.note = 'card selector not found'; break }
      await page.click(opener.id); await sleep(700)
      if (!(await click(e => e.role === 'clickable' && e.t === cd, 1400))) { R.quotes.push({ method: '카드', card: cd, cost: 0, available: false, note: 'card not listed' }); continue }
      const st = await read()
      if (cur(st) !== cd) { R.quotes.push({ method: '카드', card: cd, cost: 0, available: false, note: 'not selected: ' + cur(st) }); continue }
      const inst = st.t.match(new RegExp(cd.replace(/카드$/, '') + '카드 (\\d+)% 즉시할인이 적용'))
      R.quotes.push(row('카드', cd, st, inst ? { promo: `${inst[1]}% 즉시할인 적용` } : null))
    }
    continue
  }
  if (!PAYS.includes(m)) { R.quotes.push({ method: m, cost: 0, available: false, note: 'unknown method' }); continue }
  if (!(await click(e => e.role === 'clickable' && e.t === '페이/Pay'))) { R.note = 'pay tab not found'; break }
  if (!(await click(e => e.role === 'clickable' && e.t === m, 1400))) { R.quotes.push({ method: m, cost: 0, available: false, note: 'not listed' }); continue }
  const st = await read()
  // 배너 '토스페이 최대 13,000원 혜택 …선착순' 만 promo 로 남긴다(목록 배지는 어느 수단 것인지 모호)
  const promo = (st.t.match(new RegExp(m + ' 최대 ([0-9,]+천?원) 혜택')) || [])[1] || null
  const unreg = m === 'H포인트페이' && /새로운 카드\/계좌 등록하기/.test(st.t)
  R.quotes.push(row(m, null, st, { registered: !unreg, available: !unreg && st.total > 0, promo }))
}
R.ok = R.quotes.some(q => q.cost > 0 && q.available !== false)
if (!R.ok && !R.note) R.note = 'no usable quote'
return R
