// H몰 주문 상세(2026-09-27, 미실측 — 이 계정은 주문 내역이 없다): 주문/배송 내역(/mo/mpa/selectOrdDlvCrst)에서
// 주문번호(source_order_no) 또는 상품명이 맞는 주문을 열어 실결제액·사용 포인트·적립 예정·결제수단을 읽는다.
// 원가 = paid × 카드 청구할인 − reward + points_used(무신사와 같은 구조). 형식을 못 읽으면 raw 에 화면 일부를 남긴다(AI 수리용).
// 인자 {source_order_no?, name?, profile?} · 반환 {ok, source_order_no, order_no, paid, points_used, hpoint_used, cash_used, reward, card, method, status, raw, note}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const pf = args.profile ? { profile: args.profile } : {}
const R = { ok: false, order_no: null, paid: null, points_used: 0, hpoint_used: 0, cash_used: 0, reward: 0, card: null, method: null, status: null, raw: null, note: null }
const tree = async () => { for (let i = 0; i < 4; i++) { try { const g = await page.get({}); if (g && g.tree) return g.tree } catch (e) {} await sleep(500) } return '' }
const text = async () => nz((await tree()).split('PAGE TEXT:')[1])
const els = t => t.split('PAGE TEXT')[0].split('\n').map(l => l.match(/^\[(\d+)\] (\S+)(?: "([^"]*)")?(.*)$/)).filter(Boolean).map(m => ({ id: +m[1], role: m[2], t: nz(m[3]), rest: m[4] }))
const tid = (String(await tabs.open({ ...pf, url: 'https://www.hmall.com/mo/mpa/selectOrdDlvCrst' })).match(/tab (\S+)/) || [])[1]
if (tid) await tabs.switch(tid)
const done = async r => { if (tid) { try { await tabs.close(tid) } catch (e) {} } return r }
try { await page.waitFor(/주문\/배송 내역/, 10000) } catch (e) {}
if (/cob\/loginForm/.test(await page.url())) return done({ ...R, note: 'login_required' })
let t = await text()
if (/내역이 없습니다/.test(t)) return done({ ...R, note: 'no orders in period' })
const no = String(args.source_order_no || '').replace(/\D/g, '')
// 주문 상세로: 주문번호 글자가 든 링크/버튼, 없으면 상품명이 든 첫 줄의 '주문상세'
const E = els(await tree())
let target = no ? E.find(e => (e.role === 'link' || e.role === 'button') && e.t.replace(/\D/g, '').includes(no)) : null
if (!target && args.name) {
  const k = t.indexOf(nz(args.name))
  const dets = E.filter(e => /주문 ?상세|상세보기/.test(e.t))
  target = k >= 0 && dets.length ? dets[0] : null
}
// 번호·이름으로 못 찾으면 남의 주문을 열지 않는다(첫 주문 대체 금지)
if (!target) return done({ ...R, note: 'order link not found', raw: t.slice(0, 600) })
await page.click(target.id)
try { await page.waitFor(/결제|주문번호/, 10000) } catch (e) {}
await sleep(1000)
t = await text()
R.order_no = R.source_order_no = (t.match(/주문번호\s*:?\s*(\d{8,})/) || [])[1] || (no || null)
if (no && R.order_no && R.order_no !== no) return done({ ...R, note: `order no ${R.order_no} != ${no}` })
if (!no && args.name && !t.includes(nz(args.name))) return done({ ...R, note: 'opened order is not ' + nz(args.name).slice(0, 40) })
const amt = re => num((t.match(re) || [])[1])
R.paid = amt(/(?:총 ?결제금액|최종 ?결제금액|실 ?결제금액)\s*:?\s*([\d,]+)\s*원/) || null
R.hpoint_used = amt(/H\.Point(?: 사용)?\s*-?\s*([\d,]+)\s*P?/)
R.cash_used = amt(/적립금(?: 사용)?\s*-?\s*([\d,]+)\s*원/)
R.points_used = R.hpoint_used + R.cash_used
R.reward = amt(/([\d,]+)\s*P\s*(?:적립 ?예정|적립)/)
R.method = (t.match(/(네이버페이|토스페이|카카오페이|페이코|H포인트페이|삼성페이|스마일페이|신용카드|카드)/) || [])[1] || null
R.card = (t.match(/(현대|롯데|KB국민|국민|신한|NH농협|농협|삼성|하나|우리|비씨)카드/) || [])[0] || null
R.status = (t.match(/(결제완료|주문접수|상품준비중|배송중|배송완료|취소완료|취소접수)/) || [])[1] || null
R.raw = t.slice(0, 900)
R.ok = !!R.paid
if (!R.ok) R.note = 'paid not found — raw 확인'
return done(R)
