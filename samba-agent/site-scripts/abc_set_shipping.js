// ABC마트·그랜드스테이지 주문서 배송지 '신규입력'에 이름·주소(우편번호 찾기 → 카카오 우편번호 팝업)·상세주소를 넣고 되읽는다.
// 2026-09-26 신규: 주소록에 사무실 배송지가 없는 계정(buyer02 등) 까대기용. 이번 주문서에만 넣는다('내 배송지에 추가' 안 켬).
// 전화 칸은 비워 두고 phone_field_id 로 알린다(하네스가 키마스터로 채운다). 주문서 탭은 이메일 아이디=profile 인 것 하나만.
// args: name, address, address_detail, postal_code(선택), profile, tab(선택) · 반환 {ok, name, address, address_detail, postal_code, phone_field_id, note}
const lines = s => s.tree.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const valOf = l => ((l || '').match(/value="([^"]*)"/) || [])[1] || ''
const norm = s => String(s || '').replace(/\s+/g, '')
const isOrderUrl = u => /^https:\/\/(abcmart|grandstage)\.a-rt\.com\/order(?:[?#]|$)/.test(u || '')
const profile = String(args.profile || '').trim().toLowerCase().split('@')[0]
const name = String(args.name || '').trim(), addr = String(args.address || '').trim(), det = String(args.address_detail || '').trim()
const fail = note => ({ ok: false, name: null, address: null, address_detail: null, phone_field_id: null, note })
if (!name || !addr) return fail('name·address 인자 없음')
const oTab = String(args.tab || args.order_tab || '')
if (!profile && !oTab) return fail('no profile/tab — 주문서 탭을 고를 수 없음')
// 주소 포함 비교 — 건물번호 뒤에 숫자가 이어지면 다른 주소('사무실길 58' ≠ '사무실길 580')
const addrHas = (h, w) => { const t = String(w || '').trim().split(/\s+/).filter(Boolean).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); return !!t.length && new RegExp(t.join('\\s*') + '(?![-\\d])').test(String(h || '')) }

const hit = []
for (const t of ((await tabs.list()) || []).filter(t => isOrderUrl(t.url) && (!oTab || t.id === oTab))) {
  await tabs.switch(t.id)
  const email = valOf(lines(await page.get({ selector: 'input[name=buyerEmailAddrText]' }))[0]).toLowerCase()
  if (!profile || email.split('@')[0] === profile) hit.push(t.id)
}
if (hit.length !== 1) return fail(hit.length ? `이 계정 주문서 탭 ${hit.length}개 — 고르지 않음` : '이 계정 주문서 탭 없음')
const tabId = hit[0]
const focus = async () => { try { await tabs.switch(tabId) } catch (e) {} }
// 배송지 칸: 이름·휴대폰번호·우편번호·주소·상세주소
const fields = async () => {
  await focus()
  const ls = lines(await page.get({ selector: '#tabAddress1', interactive: true }))
  const pick = re => { const l = ls.find(x => re.test(x)); return l ? { id: parseInt(l.slice(1)), v: valOf(l).trim() } : { id: null, v: '' } }
  const bare = ls.filter(x => /\] textbox value="/.test(x)).map(l => ({ id: parseInt(l.slice(1)), v: valOf(l).trim() }))
  return { name: pick(/textbox "이름"/), phone: pick(/textbox "휴대폰번호"/), zip: pick(/textbox "우편번호"/), addr: bare[0] || {}, det: bare[1] || {} }
}

// 1) 신규입력
await focus()
const nw = await page.idOf('신규입력')
if (nw < 0) return fail('신규입력 없음')
await page.click(nw)
let f = await fields()
for (let i = 0; i < 10 && f.addr.v; i++) { await sleep(200); f = await fields() }
if (!f.name.id || !f.phone.id) return fail('배송지 입력 칸을 못 찾음')
await page.type(f.name.id, name)

// 2) 우편번호 찾기 → 팝업(카카오 우편번호, 프레임 안 요소 id 100000 이상)
const before = new Set(((await tabs.list()) || []).filter(t => t.kind === 'popup').map(t => t.id))
const zb = await page.idOf('우편번호 찾기')
if (zb < 0) return fail('우편번호 찾기 버튼 없음')
await focus(); await page.click(zb)
let pop = null
for (let i = 0; i < 20 && !pop; i++) { await sleep(250); pop = ((await tabs.list()) || []).find(t => t.kind === 'popup' && !before.has(t.id)) }
if (!pop) return fail('우편번호 팝업이 안 뜸')
await tabs.switch(pop.id)
let box = null
for (let i = 0; i < 20 && !box; i++) { box = lines(await page.get({ interactive: true })).find(l => /name=region_name/.test(l)); if (!box) await sleep(250) }
if (!box) { try { await tabs.close(pop.id) } catch (e) {} return fail('우편번호 검색칸 없음') }
await page.type(parseInt(box.slice(1)), addr, true)
// 결과 중 도로명 주소 버튼(입력 주소와 같은 것)
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
let res = null
for (let i = 0; i < 20 && !res; i++) {
  await sleep(250)
  const ls = lines(await page.get({ interactive: true }))
  res = ls.find(l => new RegExp(`\\] button "${esc(addr)}"`).test(l))
  if (!res && i === 8) { const s = ls.find(l => /\] button "검색"/.test(l)); if (s) try { await page.click(parseInt(s.slice(1))) } catch (e) {} }
}
if (!res) { try { await tabs.close(pop.id) } catch (e) {} return fail('우편번호 검색 결과에 같은 주소 없음') }
try { await page.click(parseInt(res.slice(1))) } catch (e) {}
// 팝업이 닫히고 주문서 주소 칸이 채워질 때까지
for (let i = 0; i < 25 && !addrHas(f.addr.v, addr); i++) { await sleep(250); f = await fields() }
if (!addrHas(f.addr.v, addr)) { try { await tabs.close(pop.id) } catch (e) {} return fail('주소가 주문서에 안 들어감') }

// 3) 상세주소 — 전화 칸은 비워 둔다
if (det && f.det.id) await page.type(f.det.id, det)
f = await fields()
const ok = norm(f.name.v) === norm(name) && addrHas(f.addr.v, addr) && (!det || norm(f.det.v) === norm(det))
return { ok, name: f.name.v, address: f.addr.v, address_detail: f.det.v, postal_code: f.zip.v, phone_field_id: f.phone.id, note: ok ? null : '되읽은 배송지가 입력과 다름' }
