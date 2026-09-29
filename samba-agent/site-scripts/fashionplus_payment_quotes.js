// 패션플러스 주문서에서 결제수단별 '총 결제 예상금액'·적립을 읽는다(주문하기는 누르지 않는다). 2026-09-27 새 계약.
// 탭: args.tab > 이 레인의 패션플러스 주문서 탭 하나(여럿이면 expect.product_no, 못 고르면 멈춤) — '가장 최근 탭' 금지
// 아이콘 수단(토스페이·네이버페이·페이코·카카오페이)은 라디오에 이름이 없다: 눌러서 네이버(npay_payment 하위 라디오)·페이코('PAYCO는' 안내)를 알아보고,
// 둘이 2·3번째면 1번=토스페이·4번=카카오페이. 네이버페이는 '네이버 카드간편결제'를 켠다(카드는 네이버페이 창 안에서 고른다 — card null)
// args: profile, methods(선택), tab, expect · 반환 {quotes:[{method,card,cost,reward,points_used}],base_cost,order_tab,note}
const OF = /fashionplus\.co\.kr\/order\/\d+(?:[?#]|$)/
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const lines = async q => (await page.get(q ? { selector: q } : {})).tree.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const text = async () => ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const out = note => ({ quotes: [], base_cost: null, note })
const exp = args.expect && typeof args.expect === 'object' ? args.expect : {}
const pnoOf = async () => [...new Set(((await page.get({})).tree.match(/옵션 .+? 수량 \d+개" href=\/goods\/detail\/(\d+)/g) || []).map(m => m.match(/(\d+)$/)[1]))]
let cand = (await tabs.list()).filter(t => OF.test(t.url || '') && (!args.tab || t.id === args.tab))
if (!cand.length) return out('no order tab')
if (cand.length > 1) {
  const hit = []
  for (const c of cand) { await tabs.switch(c.id); if (exp.product_no && (await pnoOf()).join() === String(exp.product_no)) hit.push(c) }
  if (hit.length !== 1) return out(`order form ambiguous: ${cand.length} tabs`)
  cand = hit
}
const tab = cand[0].id
await tabs.switch(tab)
if (!(await page.waitFor('총 결제 예상금액', 8000))) return out('order form not loaded')

const readPay = async () => {
  const t = await text()
  return { cost: num((t.match(/총 결제 예상금액 \(\d+건\) ([\d,]+)/) || [])[1]) || null, reward: num((t.match(/총 예상 적립금 \+ ([\d,]+)/) || [])[1]), points_used: num((t.match(/적립금 사용액 - ([\d,]+)/) || [])[1]), t }
}
// 결제수단 라디오: 이름표(clickable)가 바로 뒤에 붙은 것 = 글자 수단, 나머지 = 아이콘 수단
const radios = async () => {
  const ls = await lines()
  const rs = []
  ls.forEach((l, i) => {
    if (!/radio name=radio_payment-way/.test(l)) return
    const nx = (ls[i + 1] || '').match(/^\[\d+\] clickable "([^"]+)"/)
    rs.push({ id: parseInt(l.slice(1)), on: /value="on"/.test(l), label: nx && nx[1] !== '혜택' ? nx[1] : null })
  })
  return rs
}
const on = async id => { for (let i = 0; i < 12; i++) { if ((await radios()).find(r => r.id === id && r.on)) return true; await sleep(150) } return false }
let all = await radios()
if (!all.length) return out('payment radios not found')
const orig = all.find(r => r.on)
const base = await readPay()
const icons = all.filter(r => !r.label)
const kind = {}
for (const r of icons) {
  await page.click(r.id); await on(r.id); await sleep(400)
  const p = await readPay()
  if ((await lines('input[name=npay_payment]')).length) kind[r.id] = '네이버페이'
  else if (/PAYCO는/.test(p.t)) kind[r.id] = '페이코'
}
const ix = n => icons.findIndex(r => kind[r.id] === n)
if (icons.length === 4 && ix('네이버페이') === 1 && ix('페이코') === 2) { kind[icons[0].id] = '토스페이'; kind[icons[3].id] = '카카오페이' }
all = all.map(r => ({ ...r, name: r.label || kind[r.id] || null }))
const norm = s => String(s || '').replace(/[\s/·()]/g, '').toLowerCase()
const want = Array.isArray(args.methods) && args.methods.length ? args.methods : null
const targets = all.filter(r => r.name && (!want || want.some(m => norm(r.name).includes(norm(m)) || norm(m).includes(norm(r.name)))))
if (!targets.length) return { ...out(`주문서에 ${JSON.stringify(want)} 수단 없음(보이는 수단 ${all.map(r => r.name).join(',')})`), order_tab: tab }

const quotes = []
for (const r of targets) {
  await page.click(r.id)
  if (!(await on(r.id))) { quotes.push({ method: r.name, card: null, cost: null, note: 'radio not selected' }); continue }
  await sleep(400)
  if (r.name === '네이버페이') {
    const sub = await page.idOf('네이버 카드간편결제')
    if (sub >= 0) { await page.click(sub); await sleep(400) }
  }
  const p = await readPay()
  quotes.push({ method: r.name, card: null, cost: p.cost, reward: p.reward, points_used: p.points_used })
}
if (orig) { await page.click(orig.id); await on(orig.id) }
return { quotes, base_cost: base.cost, order_tab: tab, methods_seen: all.map(r => r.name), note: quotes.length ? null : 'no methods tested' }
