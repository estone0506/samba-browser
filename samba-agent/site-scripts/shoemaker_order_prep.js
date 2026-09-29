// 슈마커 주문서 정돈 — 슈머니가 전환(가능할 때) → 쿠폰(가장 큰 1장, 바뀌면 포인트 초기화라 먼저) → 포인트 모두 사용.
// 주문서 탭은 공통 규칙으로 하나만. 총액을 못 읽으면 ok:false.
// 반환 {ok,total,coupon,cart_coupon,points_used,points_balance,shoemoney_used,reward,order_tab,order_item,note,why?}
const lines = s => s.tree.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const idOf = l => parseInt(l.slice(1))
const text = async () => ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const num = s => s ? parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0 : 0
const until = async (fn, ms) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(200) } }
const amounts = t => [/최종 주문금액 ([\d,]+)/, /쿠폰할인 -?([\d,]+)/, /포인트 사용 -?([\d,]+)/, /슈머니 사용 -?([\d,]+)/].map(r => (t.match(r) || [])[1]).join('|')
const changed = async (before, ms) => { await until(async () => amounts(await text()) !== before, ms); await page.waitFor(/최종 주문금액/, 5000) }
const notes = []
// --- 주문서 탭(공통): '가장 최근 탭' 금지 ---
const OF = /shoemarker\.co\.kr\/ASP\/Order\/Order\.asp/i
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SZ = /(?<![\d.])\d{2,3}(?:\.5)?(?![\d.])/g
// 흔한 말(payer._GENERIC_WORDS)
const GEN = new Set('매장정품 정품 신발 운동화 스니커즈 스니커 남성 여성 남녀공용 공용 커플 키즈 아동 나이키 아디다스 뉴발란스 푸마 반스 컨버스 리복 아식스 휠라 NIKE ADIDAS PUMA VANS CONVERSE REEBOK ASICS FILA 블랙 화이트 그레이 네이비 BLACK WHITE GREY GRAY NAVY'.split(' '))
async function formInfo() {
  const tr = (await page.get({})).tree, tx = (tr.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' '), seen = new Set()
  const items = tr.split('PAGE TEXT')[0].split('\n').map(l => l.match(/^\[\d+\] link "([^"]*\[[^\]"]+\])" href=\S*ProductCode=(\d+)/i)).filter(m => m && !seen.has(m[1] + m[2]) && seen.add(m[1] + m[2])).map(m => {
    const s = tx.match(new RegExp(esc(m[1]) + ' 사이즈 : (\\S+) 수량 : (\\d+)'))
    return { name: m[1], code: m[2], size: s ? s[1] : '' }
  })
  return { tx, items, item: items.map(i => `${i.name} ${i.size} (${i.code})`).join(' / ') }
}
function expectOf() {
  let e = args.expect
  e = typeof e === 'string' ? { name: e } : e && typeof e === 'object' ? e : {}
  const url = String(e.product_url || args.product_url || e.sku || args.sku || '')
  const code = String(e.product_no || e.product_code || (url.match(/ProductCode=(\d+)/i) || [])[1] || '')
  const sizes = `${e.option || ''} ${e.selected || e.size || ''}`.match(SZ) || []
  const words = String(e.name || '').split(/[\s/()[\],·_:-]+/).filter(w => w && !/^\d+$/.test(w) && !GEN.has(w.toUpperCase()) && !w.startsWith('옵션') && ((/[가-힣]/.test(w) && w.length >= 2) || w.length >= 4))
  return code || sizes.length || words.length ? { code, sizes, words } : null
}
function mismatch(f, e) {
  if (f.items.length !== 1) return `order items ${f.items.length}`
  const it = f.items[0]
  if (!e) return null
  if (e.code && it.code !== e.code) return `ProductCode ${it.code} != ${e.code}`
  if (e.sizes.length && !e.sizes.some(x => (it.size.match(SZ) || []).includes(x))) return `size ${it.size} != ${e.sizes}`
  if (e.words.length && !e.words.some(w => it.name.toLowerCase().includes(w.toLowerCase()))) return `name ${e.words.slice(0, 4)} not in ${it.name}`
  return null
}
async function pickForm() {
  let c = (await tabs.list()).filter(x => OF.test(x.url || ''))
  if (args.tab) c = c.filter(x => x.id === args.tab)
  if (!c.length) return { err: 'no order tab' }
  const e = expectOf(), ok = []
  // 대조 근거가 없으면 탭이 하나일 때만
  if (!e && c.length > 1) return { err: 'order form ambiguous', why: `${c.length} order tabs, no expect` }
  let why = null
  for (const x of c) {
    await tabs.switch(x.id)
    await page.waitFor(/최종 주문금액/, 8000)
    const f = await formInfo(), m = mismatch(f, e)
    if (m) why = m; else ok.push({ id: x.id, ...f })
  }
  if (ok.length !== 1) return { err: ok.length ? 'order form ambiguous' : 'order form mismatch', why: ok.length ? `${ok.length} tabs match` : why }
  await tabs.switch(ok[0].id)
  return { ...ok[0], e }
}
// --- 공통 끝 ---
const F = await pickForm()
if (F.err) return { ok: false, note: F.err, why: F.why || null }
const price = num((F.tx.match(/상품가격 ([\d,]+) ?원/) || [])[1])

// 0) 슈머니가 전환(버튼 있을 때만) — 할인을 초기화하므로 맨 먼저. 확인창은 앱이 수락
const smBtn = lines(await page.get({ selector: '[onclick*="chg_OrderSalePriceType"]' })).find(l => /슈머니/.test(l))
if (smBtn) { const b = amounts(await text()); await page.click(idOf(smBtn)); await changed(b, 4000); notes.push('shoemoney price') } else notes.push('no shoemoney price')

// 1) 쿠폰 — 할인액(원 또는 %×상품가격)이 가장 큰 것 하나
const cLink = lines(await page.get({ selector: 'a[href*="openUseCoupon"]' }))[0]
if (cLink) {
  await page.click(idOf(cLink))
  // 창이 안 뜨면 죽은 주문서(더 새 주문서가 열렸다)
  if (!await until(async () => lines(await page.get({ selector: '#UseCoupon' })).some(l => /button "적용"/.test(l)), 3000)) return { ok: false, note: 'order form stale', why: 'coupon popup did not open' }
  await sleep(300) // 목록이 늦게 찰 수 있다
  const pop = lines(await page.get({ selector: '#UseCoupon' }))
  // 숨은 체크박스는 라벨로 — 같은 이름은 하나로
  const seen = new Set()
  const boxes = pop.filter(l => / (checkbox|label) "[^"]*(원|%)/.test(l)).sort((a, b) => / checkbox /.test(b) - / checkbox /.test(a)).filter(l => { const k = (l.match(/"([^"]*)"/) || [])[1]; return !seen.has(k) && seen.add(k) }).map(l => {
    const label = (l.match(/"([^"]*)"/) || [])[1] || ''
    const won = label.match(/([\d,]+)\s*원/)
    const pct = label.match(/(\d+(?:\.\d+)?)\s*%/)
    return { id: idOf(l), label, value: won ? num(won[1]) : pct ? Math.floor(price * Number(pct[1]) / 100) : 0, on: / checked/.test(l) }
  })
  const best = boxes.sort((a, b) => b.value - a.value)[0]
  const apply = pop.find(l => /button "적용"/.test(l))
  if (best && apply) {
    if (!best.on) { await page.click(best.id); await sleep(300) }
    const b = amounts(await text())
    await page.click(idOf(apply))
    await changed(b, 4000)
    notes.push('coupon ' + best.label.slice(0, 30))
  } else {
    const close = pop.find(l => /button "(취소|닫기)"/.test(l))
    if (close) await page.click(idOf(close))
    notes.push('no coupon')
  }
}

// 2) 포인트 — 모두 사용 → 적용
let points_balance = 0
const pLink = lines(await page.get({ selector: 'a[href*="openUsePoint"]' }))[0]
if (pLink) {
  await page.click(idOf(pLink))
  const pop = await until(async () => { const p = await page.get({ selector: '#UsePoint' }); return /보유 포인트 : [\d,]+/.test(p.tree) && p }, 4000)
  const pl = pop ? lines(pop) : []
  points_balance = pop ? num(((pop.tree.split('PAGE TEXT:')[1] || '').match(/보유 포인트 : ([\d,]+)/) || [])[1]) : 0
  const all = pl.find(l => /button "모두 사용"/.test(l))
  const apply = pl.find(l => /button "적용"/.test(l))
  if (points_balance > 0 && all && apply) {
    await page.click(idOf(all)); await sleep(300)
    const b = amounts(await text())
    await page.click(idOf(apply))
    await changed(b, 4000)
  } else {
    const close = pl.find(l => /button "(취소|닫기)"/.test(l))
    if (close) await page.click(idOf(close))
  }
}

// 정돈 뒤에도 같은 주문서인가
const f2 = await formInfo(), m2 = mismatch(f2, F.e)
if (m2) return { ok: false, note: 'order form mismatch', why: 'after prep: ' + m2 }
const a = re => num((f2.tx.match(re) || [])[1])
// 총액 칸을 못 읽으면 실패(포인트 전액 결제 '0원'은 읽힌 값)
if (!/최종 주문금액 [\d,]+ ?원/.test(f2.tx)) return { ok: false, note: 'total not found', order_tab: F.id, order_item: f2.item }
const total = a(/최종 주문금액 ([\d,]+) ?원/), coupon = a(/쿠폰할인 -?([\d,]+) ?원/), shoemoney_used = a(/슈머니 사용 -?([\d,]+) ?원/)
// 원가 규칙(사용자 확정): 포인트 사용 더하고 포인트 적립 뺀다. 슈머니 사용은 할인(되더하지 않음), 슈머니 적립 제외
const points_used = a(/포인트 사용 -?([\d,]+) ?원/), reward = a(/포인트적립 ([\d,]+) ?원/)
return { ok: total > 0 || points_used > 0, total, coupon, cart_coupon: 0, points_used, points_balance, shoemoney_used, reward, order_tab: F.id, order_item: f2.item, note: notes.join('; ') }
