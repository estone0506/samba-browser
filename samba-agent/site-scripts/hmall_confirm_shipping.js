// H몰 배송지 확정(2026-09-27, 저장 단계 미실측): hmall_set_shipping 이 채운 '배송지 추가' 폼
// (전화는 하네스가 채움)에서 '저장' → 목록에서 그 항목(이름·도로명 주소) 라디오 → '선택완료' → 주문서 배송정보 되읽기.
// 인자 {name, address, profile?, tab?} · 반환 {ok, name, address, order_tab, note}
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
let E = els(await tree())
const nameBox = E.find(x => x.role === 'textbox' && x.t === '이름')
const phone = E.find(x => x.role === 'textbox' && x.t === '휴대폰번호')
if (!nameBox || !phone) return { ...R, note: '배송지 추가 폼이 열려 있지 않다(hmall_set_shipping 먼저)' }
if (!/value="[^"]{7,}"/.test(phone.rest)) return { ...R, note: '전화 칸이 비었다 — 저장하지 않는다' }
if (!/value="[^"]+"/.test(nameBox.rest)) return { ...R, note: '이름 칸이 비었다' }
const save = E.filter(x => x.role === 'button' && x.t === '저장')
if (save.length !== 1) return { ...R, note: '저장 버튼 ' + save.length }
await page.click(save[0].id)
await sleep(2000)
// 저장 뒤 목록 — 방금 항목을 이름·도로명으로 찾아 고른다
const tr = await tree()
const t = nz(tr.split('PAGE TEXT:')[1])
if (!/선택완료/.test(t)) return { ...R, note: '저장 뒤 목록이 안 보인다: ' + t.slice(-120) }
const seg = t.slice(t.indexOf('이름 순') + 4, t.lastIndexOf('선택완료'))
// 항목은 '(우편번호 5자리)' 가 있는 조각만 — 목록 끝 안내 문구가 한 조각으로 더 잡혀 라디오 수와 어긋났다(실기 2026-09-27 job 258)
const rows = seg.split(/ 수정(?: |$)/).map(nz).filter(r => /\(\d{5}\)/.test(r))
const radios = els(tr).filter(x => x.role === 'radio')
const road = (addr.match(/[가-힣0-9]+(로|길)\s*\d+(-\d+)?/) || [])[0] || addr
const idx = rows.findIndex(r => r.startsWith(name) && key(r).includes(key(road)))
if (idx < 0 || radios.length !== rows.length) return { ...R, note: idx < 0 ? 'saved row not found' : 'radios != rows' }
await page.click(radios[idx].id); await sleep(600)
const d = els(await tree()).find(x => x.role === 'button' && x.t === '선택완료')
if (!d) return { ...R, note: '선택완료 없음' }
await page.click(d.id); await sleep(1500)
const t2 = nz((await tree()).split('PAGE TEXT:')[1])
const m = t2.match(/배송정보 (\S+?)(?:기본배송지)? 배송지 변경 (.+?)(?: 01\d-| 요청사항)/)
R.name = m ? m[1] : null
R.address = m ? m[2] : null
R.ok = !!(m && R.name === name && key(R.address).includes(key(road)))
if (!R.ok) R.note = 'read-back mismatch'
return R
