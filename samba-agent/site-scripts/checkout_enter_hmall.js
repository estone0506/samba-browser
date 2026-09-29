// H몰 결제창 진입(2026-09-27, dryRun 만 실측): 주문서(/mo/oda/order)에서 결제수단을 고르고 'N원 결제하기'를 누른다.
// 수단: '카드'(카드사 = issuer 또는 card 가 '롯데카드' 같은 카드 이름) 또는 페이(네이버페이·토스페이·카카오페이·페이코·H포인트페이 …).
// 카드사를 모르면 추측하지 않고 멈춘다. H포인트페이는 등록 카드·계좌가 없으면 멈춘다.
// 인자 {card, issuer?, profile?, dryRun?, expect:{name, option, selected, product_no, product_url}, amount, tab}
// 실결제 필수: expect(name·selected·product_no)·amount>0·tab, 카드면 issuer(카드사). 탭 자동 대조는 dry 에서만.
// 카드 직접 결제(롯데 등)는 결제하기 뒤 KSNET 안심클릭 창(kspay.ksnet.to/popmpi) → 카드사 결제창이 뜬다 — pay_window 로 알린다.
// 상품 대조: 주문서엔 상품번호가 없다(실측) — 스냅샷이 만든 탭(args.tab) + 상품명 전체 + 사이즈('285 | 1개') +
//  expect.product_url 의 slitmCd 가 product_no 여야 한다. 금액: 총 결제금액 ≤ amount.
// 반환 {ok, method, card, popup_url, dry?, total, points_used, order_item, order_tab, note, error?}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const key = s => String(s || '').toLowerCase().replace(/[\s\-_/·,()[\]]+/g, '')
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const OF = /hmall\.com\/mo\/oda\/order/
const tree = async () => { for (let i = 0; i < 4; i++) { try { const g = await page.get({}); if (g && g.tree) return g.tree } catch (e) {} await sleep(500) } return '' }
const els = t => t.split('PAGE TEXT')[0].split('\n').map(l => l.match(/^\[(\d+)\] (\S+)(?: "([^"]*)")?(.*)$/)).filter(Boolean).map(m => ({ id: +m[1], role: m[2], t: nz(m[3]), rest: m[4] }))
const read = async () => {
  const tr = await tree(), t = nz(tr.split('PAGE TEXT:')[1]), E = els(tr)
  const boxes = E.filter(e => e.role === 'textbox' && /name=useGcAmt/.test(e.rest)).map(e => num((e.rest.match(/value="([^"]*)"/) || [])[1]))
  const items = [...t.matchAll(/상품정보 (.+?) (\S+) \| (\d+)개 ([\d,]+)원/g)]
  return { t, E, items, total: num((t.match(/총 결제금액 (?:\d+% )?([\d,]+) ?원/) || [])[1]), used: boxes.reduce((a, b) => a + b, 0) }
}
const on = v => v != null && v !== false && !/^(false|0|no|)$/i.test(String(v).trim())
const dry = on(args.dryRun) || on(args.dry_run)
const card = nz(args.card)
const amt = Math.round(Number(args.amount) || 0)
const PAYS = ['H포인트페이', '네이버페이', '카카오페이', '토스페이', '페이코', '삼성페이', '스마일페이']
const CARDS = ['현대카드', '삼성카드', 'KB국민카드', '신한카드', '하나카드', '롯데카드', 'NH농협카드', '비씨카드(페이북)', '우리카드']
const R = { ok: false, method: card || null, card: null, popup_url: null, total: null, order_item: null, note: null }
const fail = (error, note) => ({ ...R, ok: false, error, note: note || error })
const ex = args.expect && typeof args.expect === 'object' ? args.expect : null
if (!dry) {
  if (!ex || !nz(ex.name) || !nz(ex.selected || ex.option) || !nz(ex.product_no)) return fail('no expect', 'expect.name·selected·product_no 필요')
  if (!(amt > 0)) return fail('no amount')
  if (!args.tab) return fail('no tab')
}
if (ex && ex.product_url && ex.product_no) {
  const pno = String(ex.product_no).replace(/\D/g, '')
  if (!new RegExp('[?&]slitmCd=' + pno + '(?!\\d)').test(String(ex.product_url))) return fail('order form mismatch', 'product_url 의 slitmCd 가 product_no 와 다르다')
}
// 수단 결정
const pay = PAYS.find(p => card.includes(p.replace('H포인트페이', 'H포인트')) || (p === 'H포인트페이' && /H\.?Point ?Pay/i.test(card)))
const issuerTxt = nz(args.issuer) || (pay ? '' : card)
const issuer = pay ? null : CARDS.find(c => issuerTxt && (issuerTxt.includes(c.replace(/카드.*$/, '')) || c.includes(issuerTxt.replace(/카드$/, '')) && issuerTxt.replace(/카드$/, '').length >= 2))
if (!pay && !issuer) return fail('unknown pay method', `card "${card}" issuer "${nz(args.issuer)}" — 카드사를 모르면 멈춘다`)
if (!dry && !pay && !nz(args.issuer)) return fail('no issuer', '카드 직접 결제는 issuer(카드사) 필수')
R.method = pay || '카드'
R.card = issuer
const mismatch = s => {
  if (s.items.length !== 1) return 'order items ' + s.items.length
  const it = s.items[0]
  if (!ex) return null
  if (nz(ex.name) && !key(it[1]).includes(key(ex.name)) && !key(ex.name).includes(key(it[1]))) return 'product name not in order item'
  const sel = nz(ex.selected)
  if (sel && key(it[2]) !== key(sel)) return `selected "${sel}" != "${it[2]}"`
  const sizes = String(ex.option || '').match(/(?<![\d.])\d{2,3}(?:\.5)?(?![\d.])/g) || []
  if (sizes.length && !sizes.includes(it[2].replace(/[^\d.]/g, ''))) return 'size ' + sizes.join('/') + ' != ' + it[2]
  if (+it[3] !== 1 && !ex.qty) return 'qty ' + it[3]
  return null
}
// 1) 주문서 탭 — 실결제는 args.tab 만. 자동 대조(딱 하나)는 dry 에서만
const ofs = (await tabs.list()).filter(t => t.kind === 'tab' && OF.test(t.url || ''))
let tab = null
if (args.tab) {
  tab = ofs.find(t => t.id === String(args.tab))
  if (!tab) return fail('not-on-order-form', 'order form tab ' + args.tab + ' not found')
} else {
  const hit = []
  for (const t of ofs) { await tabs.switch(t.id); await sleep(400); if (!mismatch(await read())) hit.push(t) }
  if (hit.length !== 1) return fail(hit.length ? 'order form ambiguous' : 'order form mismatch', `${ofs.length} order tabs, ${hit.length} match`)
  tab = hit[0]
}
await tabs.switch(tab.id)
R.order_tab = tab.id
try { await page.waitFor(/총 결제금액/, 8000) } catch (e) {}
let s = await read()
const m0 = mismatch(s)
if (m0) return fail('order form mismatch', m0)
R.order_item = `${nz(s.items[0][1])} ${s.items[0][2]} x${s.items[0][3]}`
// 2) 수단 고르기
const click = async pred => { const e = (await read()).E.find(pred); if (!e) return false; await page.click(e.id); await sleep(1500); return true }
const cur = st => (st.t.match(/휴대폰결제 (\S+) (?:일시불|\d+개월)/) || [])[1] || null
if (pay) {
  if (!(await click(e => e.role === 'clickable' && e.t === '페이/Pay'))) return fail('pay tab not found')
  if (!(await click(e => e.role === 'clickable' && e.t === pay))) return fail('pay method not listed: ' + pay)
  s = await read()
  if (pay === 'H포인트페이' && /새로운 카드\/계좌 등록하기/.test(s.t)) return fail('hpointpay not registered', 'H포인트페이에 등록 카드·계좌가 없다')
} else {
  if (!(await click(e => e.role === 'clickable' && e.t === '카드'))) return fail('card tab not found')
  const st0 = await read()
  const opener = st0.E.find(e => e.role === 'clickable' && (e.t === '신용카드 선택' || (cur(st0) && e.t === cur(st0))))
  if (!opener) return fail('card selector not found')
  await page.click(opener.id); await sleep(1000)
  // 카드사 목록은 전체 트리 150개 밖에 있을 수 있다 — 카드사 이름으로 좁혀 읽고 마지막(목록 안) 항목을 누른다(2026-09-27 실측)
  const q = String((await page.get({ query: issuer })).tree).split('PAGE TEXT')[0].split(/\n/).filter(l => l.includes('clickable "' + issuer + '"'))
  if (!q.length) return fail('card not listed: ' + issuer)
  await page.click(parseInt(q[q.length - 1].slice(1))); await sleep(1500)
  s = await read()
  if (cur(s) !== issuer) return fail('card not selected', 'selected ' + cur(s))
}
// 3) 직전 재대조 — 상품·금액
const m2 = mismatch(s)
if (m2) return fail('order form mismatch', 'before pay: ' + m2)
R.total = s.total
R.points_used = s.used
if (!(s.total > 0)) return fail('total not found', s.used ? 'total 0 with points ' + s.used : null)
if (amt > 0 && s.total > amt) return fail('amount exceeded', `total ${s.total} > expected ${amt}`)
const btn = (await read()).E.filter(e => e.role === 'button' && new RegExp('^' + s.total.toLocaleString('en-US') + '원 결제하기$').test(e.t))
if (btn.length !== 1) return fail('pay button not found', `buttons ${btn.length} for ${s.total}`)
if (dry) return { ...R, ok: true, dry: true, pay_button: btn[0].t, note: 'dryRun: 결제하기 전 멈춤' }
// 4) 실결제 진입 — 결제창(팝업·새 탭)
const before = new Set((await tabs.list()).map(t => t.id))
await page.click(btn[0].id)
let popup = null
for (let i = 0; i < 15 && !popup; i++) {
  await sleep(800)
  popup = (await tabs.list()).find(t => !before.has(t.id)) || null
  if (!popup && !OF.test(await page.url())) popup = { url: await page.url() }
}
const pu = popup ? String(popup.url || '') : ''
const kind = /ksnet|lottecard|isaackorea|vpay|kcp/i.test(pu) ? 'card_mpi' : pay ? 'easy_pay' : 'unknown'
return { ...R, ok: !!popup, popup_url: pu || null, pay_window: kind, note: popup ? null : 'no payment window' }
