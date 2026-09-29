// H몰 기존 배송지 고르기(2026-09-27): 주문서 '배송지 변경' 목록에서 이름·주소가 맞는 항목의 라디오를 누르고 '선택완료'.
// 새 배송지는 만들지 않는다. 목록에 없으면 ok:false(닫고 끝).
// 인자 {name, address, address_detail?, profile?, tab?} · 반환 {ok, name, address, order_tab, note}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const key = s => String(s || '').replace(/[\s,()\-]/g, '').replace(/^(경북|경상북도)/, '경상북도').replace(/^(서울|서울특별시)/, '서울특별시')
const OF = /hmall\.com\/mo\/oda\/order/
const tree = async () => { for (let i = 0; i < 4; i++) { try { const g = await page.get({}); if (g && g.tree) return g.tree } catch (e) {} await sleep(500) } return '' }
const els = t => t.split('PAGE TEXT')[0].split('\n').map(l => l.match(/^\[(\d+)\] (\S+)(?: "([^"]*)")?(.*)$/)).filter(Boolean).map(m => ({ id: +m[1], role: m[2], t: nz(m[3]), rest: m[4] }))
const R = { ok: false, name: null, address: null, order_tab: null, note: null }
const name = nz(args.name), addr = nz(args.address)
if (!name || !addr) return { ...R, note: 'name·address 필요' }
let c = (await tabs.list()).filter(x => OF.test(x.url || ''))
if (args.tab) c = c.filter(x => x.id === args.tab)
if (c.length !== 1) return { ...R, note: c.length ? 'order form ambiguous' : 'no order tab' }
await tabs.switch(c[0].id)
R.order_tab = c[0].id
const E = async () => els(await tree())
const b = (await E()).find(x => x.role === 'button' && x.t === '배송지 변경')
if (!b) return { ...R, note: '배송지 변경 없음' }
await page.click(b.id); await sleep(1500)
const tr = await tree()
const t = nz(tr.split('PAGE TEXT:')[1])
// 목록 구간: '이름 순' 뒤 ~ '선택완료' 앞, 항목은 '수정' 으로 끝난다
const seg = t.slice(t.indexOf('이름 순') + 4, t.lastIndexOf('선택완료'))
// 항목은 '(우편번호 5자리)' 가 있는 조각만 — 목록 끝 안내 문구가 한 조각으로 더 잡혀 라디오 수와 어긋났다(실기 2026-09-27 job 258)
const rows = seg.split(/ 수정(?: |$)/).map(nz).filter(r => /\(\d{5}\)/.test(r))
const radios = els(tr).filter(x => x.role === 'radio')
// 주소 대조: 도로명+건물번호(숫자)가 같아야
const road = (addr.match(/[가-힣0-9]+(로|길)\s*\d+(-\d+)?/) || [])[0] || addr
const idx = rows.findIndex(r => r.startsWith(name) && key(r).includes(key(road)))
const done = async () => { const d = (await E()).find(x => x.role === 'button' && x.t === '선택완료'); if (d) { await page.click(d.id); await sleep(1500) } }
if (idx < 0 || radios.length !== rows.length) { await done(); return { ...R, note: idx < 0 ? 'not in list' : `radios ${radios.length} != rows ${rows.length}` } }
await page.click(radios[idx].id); await sleep(600)
await done()
// 되읽기: '배송정보 {이름}[기본배송지] 배송지 변경 {주소}, {상세} …'
const t2 = nz((await tree()).split('PAGE TEXT:')[1])
const m = t2.match(/배송정보 (\S+?)(?:기본배송지)? 배송지 변경 (.+?)(?: 01\d-| 요청사항)/)
R.name = m ? m[1] : null
R.address = m ? m[2] : null
R.ok = !!(m && R.name === name && key(R.address).includes(key(road)))
if (!R.ok) R.note = 'read-back mismatch'
return R
