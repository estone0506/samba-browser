// H몰 배송지 입력(2026-09-27): 주문서 '배송지 변경' → '배송지 추가' 폼에 받는 분·주소(우편번호 찾기 검색)·상세주소를 넣는다.
// 저장하지 않는다 — 전화 칸은 비워 두고 phone_field_ids 로 돌려준다(하네스가 키마스터로 채운 뒤 hmall_confirm_shipping 이 저장·선택).
// 전화: 앞자리 010 은 고르는 칸(기본 010), 나머지 8자리가 한 칸 → phone_formats ['phone-rest'](슈마커와 같은 모양).
// 인자 {name, address, address_detail?, postal_code?, profile?, tab?}
// 반환 {ok, name, address, address_detail, zip, phone_field_ids, phone_formats, order_tab, note}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const key = s => String(s || '').replace(/[\s,()\-]/g, '')
const OF = /hmall\.com\/mo\/oda\/order/
const tree = async () => { for (let i = 0; i < 4; i++) { try { const g = await page.get({}); if (g && g.tree) return g.tree } catch (e) {} await sleep(500) } return '' }
const els = t => t.split('PAGE TEXT')[0].split('\n').map(l => l.match(/^\[(\d+)\] (\S+)(?: "([^"]*)")?(.*)$/)).filter(Boolean).map(m => ({ id: +m[1], role: m[2], t: nz(m[3]), rest: m[4] }))
const E = async () => els(await tree())
const text = async () => nz((await tree()).split('PAGE TEXT:')[1])
const R = { ok: false, name: null, address: null, address_detail: null, zip: null, phone_field_ids: [], phone_formats: ['phone-rest'], order_tab: null, note: null }
const fail = n => ({ ...R, note: n })
const name = nz(args.name), addr = nz(args.address), detail = nz(args.address_detail)
if (!name || !addr) return fail('name·address 필요')
let c = (await tabs.list()).filter(x => OF.test(x.url || ''))
if (args.tab) c = c.filter(x => x.id === args.tab)
if (c.length !== 1) return fail(c.length ? 'order form ambiguous: ' + c.length : 'no order tab')
await tabs.switch(c[0].id)
R.order_tab = c[0].id
const btn = async (t, role) => { const e = (await E()).find(x => x.role === (role || 'button') && x.t === t); if (!e) return false; await page.click(e.id); await sleep(1500); return true }
if (!(await btn('배송지 변경'))) return fail('배송지 변경 버튼 없음')
if (!(await btn('배송지 추가'))) return fail('배송지 추가 버튼 없음')
let F = await E()
const nameBox = F.find(x => x.role === 'textbox' && x.t === '이름')
const phoneBox = F.find(x => x.role === 'textbox' && x.t === '휴대폰번호')
if (!nameBox || !phoneBox) return fail('배송지 추가 폼 칸 없음')
await page.type(nameBox.id, name, false)
await sleep(300)
// 우편번호 찾기 — 폼 안 검색(도로명). 결과 중 우편번호(있으면)·주소 숫자가 맞는 것
if (!(await btn('우편번호 찾기'))) return fail('우편번호 찾기 없음')
const q = (await E()).find(x => x.role === 'textbox' && x.t === '주소를 입력해주세요')
if (!q) return fail('주소 검색 칸 없음')
// 검색어: 괄호·상세 뺀 도로명 주소
const qtext = addr.replace(/\(.*?\)/g, '').replace(/,.*$/, '').trim()
await page.type(q.id, qtext, false)
if (!(await btn('검색'))) return fail('검색 버튼 없음')
await sleep(1000)
const res = (await E()).filter(x => x.role === 'button' && /^도로명/.test(x.t))
if (!res.length) return fail('주소 검색 결과 없음: ' + qtext)
const zip = String(args.postal_code || '').replace(/\D/g, '')
const nums = (qtext.match(/\d+(-\d+)?/g) || [])
const hit = res.find(r => zip && r.t.includes(zip)) || res.find(r => nums.every(n => r.t.includes(n))) || (res.length === 1 ? res[0] : null)
if (!hit) return fail(`주소 결과 ${res.length}개 중 맞는 것 없음`)
await page.click(hit.id)
await sleep(1500)
F = await E()
const zipBox = F.find(x => x.role === 'textbox' && /value="\d{5}"/.test(x.rest))
const detBox = F.find(x => x.role === 'textbox' && x.t === '나머지 주소를 입력해 주세요.')
if (!zipBox || !detBox) return fail('주소 선택 후 우편번호·상세 칸 없음')
if (detail) { await page.type(detBox.id, detail, false); await sleep(300) }
// 기본 배송지 지정은 켜지 않는다
const def = F.find(x => x.role === 'checkbox' && x.t === '기본 배송지로 지정')
if (def && /value="on"/.test(def.rest)) { await page.click(def.id); await sleep(300) }
// 되읽기 — 전화 칸 id 는 마지막 페이지 읽기에서 다시 찾는다. 주소 선택 뒤 폼이 다시 그려져 처음 읽은 id 는 사라진다
// (실기 2026-09-27 job 258: fill_secret 'element 101 is gone')
const last = await tree()
F = els(last)
const t = nz(last.split('PAGE TEXT:')[1])
const phoneNow = F.find(x => x.role === 'textbox' && x.t === '휴대폰번호')
if (!phoneNow) return fail('주소 선택 후 휴대폰번호 칸 없음')
R.name = ((F.find(x => x.role === 'textbox' && x.t === '이름') || {}).rest || '').match(/value="([^"]*)"/)?.[1] || null
R.zip = (zipBox.rest.match(/value="(\d{5})"/) || [])[1]
R.address = (t.match(/우편번호 찾기 (.+?) 배송요청사항/) || [])[1] || null
R.address_detail = ((F.find(x => x.role === 'textbox' && x.t === '나머지 주소를 입력해 주세요.') || {}).rest || '').match(/value="([^"]*)"/)?.[1] || null
R.phone_field_ids = [phoneNow.id]
R.ok = !!(R.name && R.address && key(R.name) === key(name))
if (!R.ok) R.note = 'read-back mismatch'
return R
