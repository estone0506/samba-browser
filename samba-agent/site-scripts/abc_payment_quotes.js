// ABC마트·그랜드스테이지 주문서에서 결제수단별 견적(총 결제예정금액·적립예정·사용 포인트)을 읽는다. 결제하기는 누르지 않는다.
// 2026-09-26 재작성: 주문서 탭은 이메일 아이디=profile(+args.tab·order_tab·expect, profile·tab 둘 다 없으면 멈춤)인 것 하나만 쓴다('가장 최근 탭' 금지).
// 카드사 콤보는 돌지 않는다(카드는 간편결제 창 안에서만 고른다 — 하네스 규칙). ABC 는 네이버페이만 허용.
// args: profile, methods(선택, 수단 이름 배열) · 반환 {quotes:[{method,card,cost,reward,points_used}], base_cost, note}
const num = s => Number(String(s || '').replace(/[^\d]/g, '') || 0)
const lines = s => s.tree.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const valOf = l => ((l || '').match(/value="([^"]*)"/) || [])[1] || ''
const isOrderUrl = u => /^https:\/\/(abcmart|grandstage)\.a-rt\.com\/order(?:[?#]|$)/.test(u || '')
const profile = String(args.profile || '').trim().toLowerCase().split('@')[0]
const oTab = String(args.tab || args.order_tab || '')
if (!profile && !oTab) return { quotes: [], base_cost: null, note: 'no profile/tab — 주문서 탭을 고를 수 없음' }
const exp = typeof args.expect === 'string' ? { name: args.expect } : args.expect || {}
const productOf = t => { const m = t.match(/배송 상품 (.{2,160}?) ([^\s\/]{1,20})\s*\/\s*(\d+)\s*개/); return m ? { name: m[1], option: m[2] } : null }
const GENERIC = new Set('나이키 아디다스 뉴발란스 푸마 반스 컨버스 리복 아식스 휠라 스케쳐스 크록스 머렐 NIKE ADIDAS PUMA VANS CONVERSE REEBOK ASICS FILA SKECHERS CROCS MERRELL 매장정품 정품 신발 운동화 스니커즈 남성 여성 공용 남녀공용 키즈 아동 블랙 화이트 BLACK WHITE'.split(' '))
const words = s => String(s || '').split(/[\s\/()\[\],·_:-]+/).filter(w => ((/[가-힣]/.test(w) && w.length >= 2) || w.length >= 4) && !/^\d+$/.test(w) && !GENERIC.has(w.toUpperCase()))
function matches(p, extra) {
  if (!exp.name && !exp.option) return true
  if (!p) return false
  const hay = (p.name + ' ' + extra).toLowerCase().replace(/\s+/g, '')
  const sz = String(exp.option || '').match(/\d{2,3}(?:\.5)?/g) || []
  if (sz.length && !sz.includes(p.option)) return false
  const w = words(exp.name)
  const n = w.filter(x => hay.includes(x.toLowerCase())).length
  return !w.length || n >= Math.max(Math.min(2, w.length), w.length * 0.6)
}
const text = async sel => ((await page.get(sel ? { selector: sel } : {})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
// 한글 상품명은 쿠폰 창에만 있다 — 대조가 필요한데 창이 안 불려 있으면 한 번 열어 불러온 뒤 닫는다
async function korName() {
  const read = async () => (await text('#tabPopupCoupon1')).slice(0, 200)
  let t = await read()
  if (t.trim() || !(exp.name || exp.option)) return t
  const b = await page.idOf('쿠폰적용')
  if (b < 0) return ''
  await page.click(b)
  for (let i = 0; i < 20 && !(t = await read()).trim(); i++) await sleep(200)
  const c = await page.idOf('Close')
  if (c >= 0) await page.click(c)
  // 닫기 버튼을 못 찾거나 안 닫히면 오버레이 닫기로 한 번 더(뒤 클릭을 가리지 않게)
  await sleep(300)
  if (lines(await page.get({ selector: '#tabPopupCoupon1', interactive: true })).length) { try { await page.dismissOverlay() } catch (e) {} }
  return t
}

// 이 계정(·이 상품) 주문서 탭 하나를 고른다 — 0개·2개 이상이면 견적하지 않는다
const hit = []
let seen = 0
for (const t of ((await tabs.list()) || []).filter(t => isOrderUrl(t.url) && (!oTab || t.id === oTab))) {
  await tabs.switch(t.id)
  const email = valOf(lines(await page.get({ selector: 'input[name=buyerEmailAddrText]' }))[0]).toLowerCase()
  if (profile && email.split('@')[0] !== profile) continue
  seen++
  if (matches(productOf(await text()), await korName())) hit.push(t.id)
}
if (hit.length !== 1) return { quotes: [], base_cost: null, note: hit.length ? `주문서 탭 ${hit.length}개 — 고르지 않음` : seen ? 'order form mismatch' : `이 계정(${profile}) 주문서 탭 없음` }
const tabId = hit[0]
const focus = async () => { try { await tabs.switch(tabId) } catch (e) {} }

const radios = async () => {
  await focus()
  return lines(await page.get({ selector: 'input[name=rgPaymentModule]' })).map(l => ({ id: parseInt(l.slice(1)), label: (l.match(/radio "([^"]+)"/) || [])[1], on: /value="on"/.test(l) })).filter(r => r.label)
}
const readPay = async () => {
  await focus()
  const t = await text()
  return {
    cost: num((t.match(/총\s*결제예정금액\s*([\d,]+)\s*원/) || [])[1]) || null,
    // 적립예정 P — 구매 적립(후기 적립은 주문서에 안 나온다)
    reward: num((t.match(/([\d,]+)\s*P\s*적립\s*예정/) || [])[1]),
    points_used: num((t.match(/포인트\s*사용\s*([\d,]+)\s*P\s*기프트카드/) || [])[1]) + num((t.match(/기프트카드\s*([\d,]+)\s*원\s*총\s*결제예정/) || [])[1])
  }
}
let all = await radios()
if (!all.length) return { quotes: [], base_cost: null, note: 'payment method UI not found on order page' }
const orig = all.find(r => r.on)
const norm = s => String(s || '').replace(/[\s\/·]/g, '').toLowerCase()
const want = Array.isArray(args.methods) && args.methods.length ? args.methods : null
const targets = want ? all.filter(r => want.some(m => norm(r.label).includes(norm(m)) || norm(m).includes(norm(r.label)))) : all
if (!targets.length) return { quotes: [], base_cost: null, note: `주문서에 ${JSON.stringify(want)} 수단 없음(보이는 수단 ${all.map(r => r.label).join(',')})` }

const base = await readPay()
const quotes = []
for (const r of targets) {
  if (!r.on) {
    await focus(); await page.click(r.id)
    // 수단을 바꾸면 결제예정금액이 다시 계산될 수 있다 — 라디오가 켜질 때까지만 기다린다
    for (let i = 0; i < 10 && !(await radios()).find(x => x.id === r.id && x.on); i++) await sleep(150)
  }
  const p = await readPay()
  quotes.push({ method: r.label, card: null, cost: p.cost, reward: p.reward, points_used: p.points_used })
}
// 원래 수단으로 되돌린다
if (orig && !(await radios()).find(x => x.id === orig.id && x.on)) { await focus(); await page.click(orig.id) }
return { quotes, base_cost: base.cost, order_tab: tabId, note: quotes.length ? null : 'no methods tested' }
