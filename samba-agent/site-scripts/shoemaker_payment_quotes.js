// 슈마커 주문서 결제수단 견적 — 금액은 수단과 무관하게 '최종 주문금액' 하나다(쿠폰·포인트·슈머니는 정돈에서 이미 반영).
// 수단 이름은 하네스가 제공자를 알아보게 쓴다: '슈마커 간편결제'(=site, 등록 카드 현대카드 → 청구할인), 네이버페이, 페이코.
// 2026-09-26 보강: 주문서 탭은 공통 규칙으로 하나만 고른다('가장 최근 탭' 금지). 맞는 게 없으면 note:'order form mismatch'.
// 반환 {quotes:[{method,card,cost,reward,points_used}], base_cost, order_tab, order_item, note?, why?}
const num = s => s ? parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0 : 0
// --- 주문서 탭(공통): '가장 최근 탭' 금지(2026-09-26 사고). args.tab > args.expect{name,option,selected,product_url}·args.product_url 대조 > 탭 하나뿐 ---
const OF = /shoemarker\.co\.kr\/ASP\/Order\/Order\.asp/i
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SZ = /(?<![\d.])\d{2,3}(?:\.5)?(?![\d.])/g
// 흔한 말(하네스 payer._GENERIC_WORDS)
const GEN = new Set('매장정품 정품 신발 운동화 스니커즈 스니커 남성 여성 남녀공용 공용 커플 키즈 아동 나이키 아디다스 뉴발란스 푸마 반스 컨버스 리복 아식스 휠라 NIKE ADIDAS PUMA VANS CONVERSE REEBOK ASICS FILA 블랙 화이트 그레이 네이비 BLACK WHITE GREY GRAY NAVY'.split(' '))
// 상품 줄: link "NIKE 코트비전 로우 [IB2998-004]" href=…ProductCode=48761 · '… 사이즈 : 280 수량 : 1'
async function formInfo() {
  const tr = (await page.get({})).tree, tx = (tr.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' '), seen = new Set()
  const items = tr.split('PAGE TEXT')[0].split('\n').map(l => l.match(/^\[\d+\] link "([^"]*\[[^\]"]+\])" href=\S*ProductCode=(\d+)/i)).filter(m => m && !seen.has(m[0].replace(/^\[\d+\]/, '')) && seen.add(m[0].replace(/^\[\d+\]/, ''))).map(m => {
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
if (F.err) return { quotes: [], base_cost: null, note: F.err, why: F.why || null }
const t = F.tx
const cost = num((t.match(/최종 주문금액 ([\d,]+) ?원/) || [])[1]) || null
// 원가 규칙(사용자 확정): 포인트 사용 더하고 포인트 적립 뺀다. 슈머니 사용은 할인(되더하지 않음), 슈머니 적립은 넣지 않는다
const reward = num((t.match(/포인트적립 ([\d,]+) ?원/) || [])[1])
const points_used = num((t.match(/포인트 사용 -?([\d,]+) ?원/) || [])[1])
if (!cost) return { quotes: [], base_cost: null, order_tab: F.id, note: 'total not found' }
const want = Array.isArray(args.methods) && args.methods.length ? args.methods : null
// 간편결제는 등록 카드가 현대카드 — card 에 카드사를 실어 하네스 청구할인 계산이 보게 한다
const quotes = [['슈마커 간편결제', '현대카드'], ['네이버페이', null], ['페이코', null]]
  .filter(([m]) => !want || want.includes(m))
  .map(([method, card]) => ({ method, card, cost, reward, points_used }))
return { quotes, base_cost: cost, order_tab: F.id, order_item: F.item }
