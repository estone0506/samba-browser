// 슈마커 주문서에서 결제수단을 고르고 '주문하기'로 결제창을 연다(실결제 진입). 간편결제(토스 브랜드페이, 현대카드)는
// 창 금액 대조 뒤 '결제하기'로 키패드까지(비밀번호는 키마스터), 네이버페이·페이코는 팝업. 안전장치:
//  탭: args.tab > expect 대조 > 탭 하나뿐. 실결제는 expect(상품번호·사이즈)·amount 필수, 죽은 주문서면 멈춤. dryRun/dry_run 이면 주문하기 전 멈춤
const lines = s => s.tree.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const idOf = l => parseInt(l.slice(1))
const num = s => s ? parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0 : 0
const card = String(args.card || '')
const R = { ok: false, method: card || null, popup_url: null, keypad: false }
const fail = (note, x) => ({ ...R, note, ...(x || {}) })
const on = v => v != null && v !== false && !/^(false|0|no|)$/i.test(String(v).trim())
const dry = on(args.dryRun) || on(args.dry_run)
const act = (await tabs.list()).find(t => t.active)
const OF = /shoemarker\.co\.kr\/ASP\/Order\/Order\.asp/i
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SZ = /(?<![\d.])\d{2,3}(?:\.5)?(?![\d.])/g
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
const E0 = expectOf(), amount = Math.round(Number(args.amount) || 0)
if (!dry && !(E0 && (E0.code || E0.sizes.length))) return fail('no expect', { why: 'need product_no or size' })
if (!dry && !(amount > 0)) return fail('no amount', { why: 'need amount' })
const F = await pickForm()
if (F.err) return fail(F.err, { why: F.why || null })
if (act && OF.test(act.url || '') && act.id !== F.id) return fail('order form mismatch', { why: 'active order tab is not the matched one' })
Object.assign(R, { order_tab: F.id, order_item: F.item })
let live = null
for (const [a, box] of [['openUsePoint', '#UsePoint'], ['openUseCoupon', '#UseCoupon']]) {
const l = lines(await page.get({ selector: `a[href*="${a}"]` }))[0]
if (!l) continue
await page.click(idOf(l))
let x = null
for (let i = 0; i < 12 && !x; i++) { const p = lines(await page.get({ selector: box })); x = p.find(l => /button "닫기"/.test(l)) || p.find(l => /button "취소"/.test(l)); if (!x) await sleep(250) }
if (!x) return fail('order form stale', { why: box + ' popup did not open' })
await page.click(idOf(x))
live = box
break
}
if (!live) return fail('order form stale unverifiable', { why: 'no point/coupon link' })

const pick = [['네이버', 'PayType_N'], ['페이코', 'PayType_PAYCO'], ['간편결제', 'PayType_O'], ['슈마커', 'PayType_O']].find(([k]) => card.includes(k))
if (!pick) return fail('unknown pay method: ' + card)
const tossAmounts = r => [...new Set(String(r).split('\n').filter(l => /^\[\d{6,}\]/.test(l)).flatMap(l => [...l.matchAll(/(\d{1,3}(?:,\d{3})+|\d+) ?원/g)].map(m => num(m[1]))).filter(n => n > 0))]
const totalOf = tx => num((tx.match(/최종 주문금액 ([\d,]+) ?원/) || [])[1])
R.total = totalOf(F.tx)
if (!R.total) return fail('total not found')
if (amount > 0 && R.total > amount) return fail(`total ${R.total} > expected ${amount}`)

for (const sel of ['label[for=sel_PayType_S]', 'label[for=' + pick[1] + ']']) {
const l = lines(await page.get({ selector: sel }))[0]
if (!l) return fail('pay option not found: ' + sel)
await page.click(idOf(l))
await sleep(400)
}

const f2 = await formInfo(), m2 = mismatch(f2, F.e)
if (m2) return fail('order form mismatch', { why: 'before order: ' + m2 })
if (totalOf(f2.tx) !== R.total) return fail(`total changed ${R.total} -> ${totalOf(f2.tx)}`)
const ob = await page.idOf('주문하기')
if (ob < 0) return fail('order button not found')
if (dry) return { ...R, ok: true, dry: true, order_button: ob, note: 'dryRun: 주문하기 전 멈춤' }

const before = new Set(((await tabs.list()) || []).filter(t => t.kind === 'popup').map(t => t.id))
await page.click(ob)

if (pick[1] === 'PayType_O') {
let pay = null
for (let i = 0; i < 15 && !pay; i++) {
await sleep(800)
pay = String(await page.find('결제하기')).split('\n').find(l => /^\[\d{6,}\] button "결제하기"/.test(l)) || null
}
if (!pay) return fail('toss pay button not found')
let ta = []
for (let i = 0; i < 6 && !ta.length; i++) { ta = tossAmounts(await page.find('원')); if (!ta.length) await sleep(500) }
if (!ta.length) { const ft = ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').split('\n').filter(l => /^\[frame \d+: [^\]]*toss/.test(l)).join(' '); ta = [...new Set([...ft.matchAll(/(\d{1,3}(?:,\d{3})+|\d+) ?원/g)].map(m => num(m[1])).filter(n => n > 0))] }
R.toss_amount = ta
if (!ta.length) return fail('toss amount not found')
if (!ta.includes(R.total) || Math.max(...ta) > R.total) return fail(`toss amount ${ta} != ${R.total}`)
await page.click(idOf(pay))
let keypad = false
for (let i = 0; i < 10 && !keypad; i++) {
await sleep(700)
keypad = /^\[\d{6,}\]/m.test(String(await page.find('비밀번호를 잊으셨나요')))
}
return { ...R, ok: keypad, keypad, note: keypad ? null : 'keypad not shown' }
}

let popup = null
for (let i = 0; i < 12 && !popup; i++) {
await sleep(800)
popup = ((await tabs.list()) || []).find(t => t.kind === 'popup' && !before.has(t.id)) || null
}
return { ...R, ok: !!popup, popup_url: popup ? popup.url : null, note: popup ? null : 'no payment popup' }
