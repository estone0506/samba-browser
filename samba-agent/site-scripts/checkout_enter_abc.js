// ABC마트·그랜드스테이지 주문서에서 결제수단·필수 동의 뒤 '결제하기'로 결제창을 연다(실결제 진입).
// 2026-09-26 재작성·검토 반영: 시험은 truthy(dryRun·dry_run)로 결제하기 직전에서 멈춤. 실결제에 expect 없으면 안 누름.
//  탭 = args.tab(order_tab)만, 없으면 이메일 아이디=profile·상품 일치 탭 정확히 하나. expect 없으면 보이는 탭일 때만.
//  금액 못 읽으면·포인트전액 아닌데 0원이면·args.amount 초과면 멈춤. 상품번호는 주문서에 없어 상품명 단어(2개·60% 이상)·옵션·selected 로 대조
// args: card(네이버·토스·카카오·페이코·'포인트전액'), profile, dryRun, expect{name,option,selected}, amount, tab
const num = s => Number(String(s || '').replace(/[^\d]/g, '') || 0)
const lines = s => s.tree.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const valOf = l => ((l || '').match(/value="([^"]*)"/) || [])[1] || ''
const isOrderUrl = u => /^https:\/\/(abcmart|grandstage)\.a-rt\.com\/order(?:[?#]|$)/.test(u || '')
const fail = (note, extra = {}) => ({ ok: false, method: null, popup_url: null, note, ...extra })
const dry = !!(args.dryRun || args.dry_run)
const profile = String(args.profile || '').trim().toLowerCase().split('@')[0]
const exp = typeof args.expect === 'string' ? { name: args.expect } : args.expect || {}
const hasExp = !!(exp.name || exp.option)
if (!dry && !hasExp) return fail('no expect')
const wantTab = String(args.tab || args.order_tab || '')
if (!wantTab && !profile) return fail('no profile/tab')
const productOf = t => { const m = t.match(/배송 상품 (.{2,160}?) ([^\s\/]{1,20})\s*\/\s*(\d+)\s*개/); return m ? { name: m[1], option: m[2] } : null }
const GENERIC = new Set('나이키 아디다스 뉴발란스 푸마 반스 컨버스 리복 아식스 휠라 스케쳐스 크록스 머렐 NIKE ADIDAS PUMA VANS CONVERSE REEBOK ASICS FILA SKECHERS CROCS MERRELL 매장정품 정품 신발 운동화 스니커즈 남성 여성 공용 남녀공용 키즈 아동 블랙 화이트 BLACK WHITE'.split(' '))
const words = s => [...new Set(String(s || '').split(/[\s\/()\[\],·_:-]+/).filter(w => ((/[가-힣]/.test(w) && w.length >= 2) || w.length >= 4) && !/^\d+$/.test(w) && !GENERIC.has(w.toUpperCase())).map(w => w.toLowerCase()))]
function matches(p, extra) {
  if (!hasExp) return true
  if (!p) return false
  const hay = (p.name + ' ' + extra).toLowerCase().replace(/\s+/g, '')
  const sel = String(exp.selected || '').trim()
  if (sel && sel !== p.option) return false
  const sz = String(exp.option || '').match(/\d{2,3}(?:\.5)?/g) || []
  if (sz.length && !sz.includes(p.option)) return false
  const w = words(exp.name)
  return !w.length || w.filter(x => hay.includes(x)).length >= Math.max(Math.min(2, w.length), w.length * 0.6)
}
const text = async sel => ((await page.get(sel ? { selector: sel } : {})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
// 쿠폰 창 열림 여부(닫혀도 글자는 남고 요소만 사라진다)
const popOpen = async () => lines(await page.get({ selector: '#tabPopupCoupon1', interactive: true })).length > 0
async function closePop() {
  for (let i = 0; i < 3 && (await popOpen()); i++) {
    const c = i === 0 ? await page.idOf('Close') : -1
    if (c >= 0) await page.click(c); else { try { await page.dismissOverlay() } catch (e) {} }
    await sleep(300)
  }
  return !(await popOpen())
}
// 한글 상품명은 쿠폰 창에만 — 열어 읽고 반드시 닫는다(못 닫으면 null)
async function korName() {
  const read = async () => (await text('#tabPopupCoupon1')).slice(0, 200)
  let t = await read()
  if (t.trim() || !hasExp) return (await closePop()) ? t : null
  const b = await page.idOf('쿠폰적용')
  if (b < 0) return ''
  await page.click(b)
  for (let i = 0; i < 20 && !(t = await read()).trim(); i++) await sleep(200)
  return (await closePop()) ? t : null
}

// 1) 주문서 탭 고르기
const listed = (await tabs.list()) || []
const activeOrder = listed.find(t => t.active && isOrderUrl(t.url))
const cand = listed.filter(t => isOrderUrl(t.url) && (!wantTab || t.id === wantTab))
if (wantTab && !cand.length) return fail('not on order form: tab')
const hit = []
let seen = 0
for (const t of cand) {
  await tabs.switch(t.id)
  const email = valOf(lines(await page.get({ selector: 'input[name=buyerEmailAddrText]' }))[0]).toLowerCase()
  if (profile && email.split('@')[0] !== profile) continue
  seen++
  const p = productOf(await text())
  const k = await korName()
  if (k === null) return fail('coupon popup not closed', { product: p })
  if (matches(p, k)) hit.push({ id: t.id, product: p })
}
if (!hit.length) return fail(seen ? 'order form mismatch' : 'not on order form')
if (hit.length > 1) return fail(`order form ambiguous: 이 계정 주문서 탭 ${hit.length}개`)
const tabId = hit[0].id
const product = hit[0].product
if (activeOrder && activeOrder.id !== tabId) return fail('order form mismatch: 보이는 탭≠고른 탭', { product })
if (!hasExp && (!activeOrder || activeOrder.id !== tabId)) return fail('no expect: 보이는 탭이 고른 주문서가 아님', { product })
const focus = async () => { try { await tabs.switch(tabId) } catch (e) {} }
// 전체 트리는 잘린다(그랜드스테이지) — selector·글자로 찾는다
const sel = async q => { await focus(); return (await page.get({ selector: q })).tree.split('PAGE TEXT')[0] }

// 2) 결제수단·금액
const card = String(args.card || '').trim()
const pointsOnly = card === '포인트전액'
const map = { 네이버: '네이버페이', 토스: 'TOSS', TOSS: 'TOSS', 카카오: '카카오페이', 페이코: '페이코' }
const key = Object.keys(map).find(k => card.includes(k))
const radioLabel = key ? map[key] : null
if (!radioLabel && !pointsOnly) return fail('unknown pay method: ' + card, { product })
await focus()
const tm = (await text()).match(/총\s*결제예정금액\s*([\d,]+)\s*원/)
if (!tm) return fail('total not read', { method: card, product })
const total = num(tm[1])
if (pointsOnly && total !== 0) return fail('points_only but total not 0', { method: card, product, total })
if (!pointsOnly && total === 0) return fail('total 0 but not points_only', { method: card, product, total })
const amount = Number(args.amount) || 0
if (amount > 0 && total > amount) return fail(`total ${total} > amount ${amount}`, { method: card, product, total })
const radioOn = async () => new RegExp(`radio "${radioLabel}" name=rgPaymentModule value="on"`).test(await sel('input[name=rgPaymentModule]'))
if (!pointsOnly) {
  const rM = (await sel('input[name=rgPaymentModule]')).match(new RegExp(`\\[(\\d+)\\] radio "${radioLabel}" name=rgPaymentModule`))
  if (!rM) return fail('pay radio not found', { method: radioLabel, product })
  if (!(await radioOn())) {
    await focus(); await page.click(parseInt(rM[1]))
    for (let i = 0; i < 10 && !(await radioOn()); i++) await sleep(150)
  }
  if (!(await radioOn())) return fail('pay radio not selected', { method: radioLabel, product })
}

// 3) 주문 동의(checkAgree) — 숨은 체크박스라 라벨로 켜고 value="on" 확인
const agreeOn = async () => /value="on"/.test(await sel('input[name=checkAgree]'))
if (!(await agreeOn())) { await focus(); try { await page.check('주문 내역에 대한 동의') } catch (e) {} }
for (let i = 0; i < 3 && !(await agreeOn()); i++) {
  const id = i === 0 ? await page.idOf('[필수] 주문 내역에 대한 동의') : parseInt(((await sel('input[name=checkAgree]')).match(/\[(\d+)\] checkbox/) || [])[1] || -1)
  if (id == null || id < 0) break
  await focus(); await page.click(id); await sleep(200)
}
if (!(await agreeOn())) return fail('order agreement not checked', { method: radioLabel, product })

await focus()
const payId = await page.idOf('결제하기')
if (payId < 0) return fail('pay button not found', { method: radioLabel, product })
// 시험 모드 — 결제하기를 누르지 않는다
if (dry) return { ok: true, dry: true, method: pointsOnly ? card : radioLabel, popup_url: null, total, product, order_tab: tabId, note: 'dryRun — 결제하기 직전에서 멈춤' }

if (pointsOnly) {
  await focus(); await page.click(payId)
  // 결제창 없이 주문 완료로 간다
  for (let i = 0; i < 25 && isOrderUrl(await page.url()); i++) await sleep(300)
  return { ok: true, points_only: true, method: card, popup_url: null, product, total, note: 'points only - no payment popup' }
}
const before = new Set(((await tabs.list()) || []).filter(t => t.kind === 'popup').map(t => t.id))
await focus(); await page.click(payId)
let popup = null
for (let i = 0; i < 40 && !popup; i++) {
  await sleep(250)
  popup = ((await tabs.list()) || []).find(t => t.kind === 'popup' && !before.has(t.id)) || null
}
return { ok: !!popup, method: radioLabel, popup_url: popup ? popup.url : null, product, total, note: popup ? null : 'no payment popup' }
