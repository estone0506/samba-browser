// SSG 배송지 입력(2026-09-27, 로그인 실측): 주문서 '배송지 변경'(name=btnChangeShpploc) → 목록 팝업(shpplocList)
// → '새 배송지 추가'(같은 팝업이 shpplocForm 으로 바뀜) → '우편번호 검색'(zipcd 팝업: 검색 → 첫 도로명 → 상세주소 → 팝업 '저장'=폼으로 옮기기) → 받는분 이름.
// 셀렉터는 확장앱 background-sourcing.js _handleSsgShippingPopup·_handleSsgNewAddress·_handleSsgZipcdPopup 에서 옮겼다.
// 전화는 비워 두고 칸 번호를 돌려준다(하네스 fill_secret, 010 은 select). 폼은 저장하지 않는다 — ssg_confirm_shipping 이 저장·선택·반영한다.
// 인자 {name, address, address_detail?, postal_code?, profile?, tab?}
// 반환 {ok, name, address, address_detail, phone_field_ids, phone_formats, form_popup, note}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const OF = /pay\.ssg\.com\/(order|payment)|ssg\.com\/order\//
const tree = async o => { for (let i = 0; i < 4; i++) { try { const g = await page.get(o || {}); if (g && g.tree) return g.tree } catch (e) {} await sleep(500) } return '' }
const first = async sel => { const l = (await tree({ selector: sel })).split('\n').find(x => /^\[\d+\]/.test(x)); return l ? parseInt(l.slice(1)) : -1 }
const R = { ok: false, name: null, address: null, address_detail: null, phone_field_ids: [], phone_formats: ['phone-rest'], form_popup: null, note: null }
if (!args.name || !args.address) return { ...R, note: 'name·address 필요' }
const waitPopup = async (re, ms) => { for (let i = 0; i < ms / 400; i++) { const p = (await tabs.list()).find(t => t.kind === 'popup' && re.test(t.url || '')); if (p) return p; await sleep(400) } return null }
const ofs = (await tabs.list()).filter(t => t.kind === 'tab' && OF.test(t.url || ''))
const tab = args.tab ? ofs.find(t => t.id === String(args.tab)) : ofs.length === 1 ? ofs[0] : null
if (!tab) return { ...R, note: ofs.length ? 'order forms ' + ofs.length + ' — pass args.tab' : 'no order form' }
await tabs.switch(tab.id)
let b = await first('[id^="btnChangeShpploc"], [name="btnChangeShpploc"]')
if (b < 0) b = await page.idOf('배송지 변경', 0)
if (b < 0) return { ...R, note: '배송지 변경 버튼 없음' }
await page.click(b)
const list = await waitPopup(/shpplocList/, 8000)
if (!list) {
  const lg = (await tabs.list()).find(t => t.kind === 'popup' && /member\.ssg\.com\/member\/login/.test(t.url || ''))
  if (lg) { try { await tabs.close(lg.id) } catch (e) {} return { ...R, error: 'login_required', note: 'SSG 세션 만료 — 로그인 팝업' } }
  return { ...R, note: '배송지 목록 팝업 안 뜸' }
}
await tabs.switch(list.id)
try { await page.waitFor(/배송지|로그인/, 5000) } catch (e) {}
if (/member\/login/.test(await page.url())) { try { await tabs.close(list.id) } catch (e) {} return { ...R, error: 'login_required', note: 'SSG 세션 만료 — 목록 팝업이 로그인 화면' } }
let add = -1
for (const w of ['새 배송지 추가', '배송지 추가', '새 배송지']) { if (add < 0) add = await page.idOf(w, 0) }
if (add < 0) return { ...R, note: '새 배송지 추가 버튼 없음' }
page.click(add).catch(() => {})
const form = await waitPopup(/shpplocForm/, 8000)
if (!form) return { ...R, note: '배송지 폼 팝업 안 뜸' }
R.form_popup = form.id
await tabs.switch(form.id)
try { await page.waitFor(/받는\s*분|수령인|이름|로그인/, 5000) } catch (e) {}
if (/member\/login/.test(await page.url())) { try { await tabs.close(form.id) } catch (e) {} return { ...R, error: 'login_required', note: 'SSG 세션 만료 — 배송지 폼이 로그인 화면' } }
try { await page.waitFor(/우편번호/, 8000) } catch (e) {}
let zipBtn = await page.idOf('우편번호 검색', 0)
if (zipBtn < 0) { await sleep(1500); zipBtn = await page.idOf('우편번호 검색', 0) }
if (zipBtn < 0) zipBtn = await first('#address_zipcode')
if (zipBtn < 0) return { ...R, note: '우편번호 찾기 버튼 없음' }
page.click(zipBtn).catch(() => {})
let zip = await waitPopup(/zipcd\.ssg/, 8000)
if (!zip) { await tabs.switch(form.id); const z2 = await page.idOf('우편번호 검색', 0); if (z2 >= 0) page.click(z2).catch(() => {}); zip = await waitPopup(/zipcd\.ssg/, 8000) }
if (!zip) return { ...R, note: '우편번호 팝업 안 뜸' }
await tabs.switch(zip.id)
try { await page.waitFor(/도로명/, 6000) } catch (e) {}
await sleep(500)
let kw = -1
for (let i = 0; i < 15 && kw < 0; i++) { kw = await first('input[name="searchKeyword"]'); if (kw < 0) await sleep(800) }
if (kw < 0) return { ...R, note: '주소 검색칸 없음' }
let sb = await first('.postcode_search_btn')
if (sb < 0) sb = await page.idOf('찾기', 0)
const kwVal = async () => ((await tree({ selector: 'input[name="searchKeyword"]' })).match(/value="([^"]*)"/) || [])[1] || ''
for (let i = 0; i < 4; i++) { const k = i ? await first('input[name="searchKeyword"]') : kw; if (k >= 0) await page.type(k, nz(args.address), true); await sleep(1200); if ((await kwVal()).length) break }
let pickBtn = -1
for (let i = 0; i < 10 && pickBtn < 0; i++) { await sleep(800); pickBtn = await first('button[onclick*="showZipcdDtl"]'); if (i === 4 && pickBtn < 0 && sb >= 0) await page.click(sb) }
if (pickBtn < 0) {
  const a0 = nz(args.address).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  const rm = a0.match(/([가-힣0-9]+(?:로|길)\s*\d+(?:-\d+)?)/)
  const parts = a0.split(' ')
  const region = parts.slice(1, 3).filter(p => /(시|군|구|읍|면|동)$/.test(p)).join(' ')
  const qs = [...new Set([rm && region ? region + ' ' + rm[1] : '', rm ? rm[1] : '', a0.replace(/^\S+\s+/, '')].filter(q => q && q !== nz(args.address)))]
  for (const q2 of qs) { if (pickBtn >= 0) break; const k2 = await first('input[name="searchKeyword"]'); if (k2 < 0) break; await page.type(k2, q2, true); for (let i = 0; i < 8 && pickBtn < 0; i++) { await sleep(800); pickBtn = await first('button[onclick*="showZipcdDtl"]') } }
}
if (pickBtn < 0) return { ...R, note: '주소 검색 결과 없음' }
await page.click(pickBtn)
await sleep(700)
const dtl = await first('#addrDtlInput, input[name="dtlAddr"]')
const dtlText = nz(args.address_detail) || nz((nz(args.address).split(',')[1] || '').replace(/\([^)]*\)/g, ' '))
if (dtl >= 0 && dtlText) await page.type(dtl, dtlText, false)
if (!/zipcd\.ssg/.test(await page.url())) return { ...R, note: '우편번호 팝업이 아닌 곳에서 저장 버튼을 찾으려 했다 — 멈춤' }
let ok = await first('#addrDtlBtn')
if (ok < 0) ok = await page.idOf('저장', 0)
if (ok < 0 || !/zipcd\.ssg/.test(await page.url())) return { ...R, note: '우편번호 팝업 저장 버튼 없음' }
if (ok >= 0) page.click(ok).catch(() => {})
for (let i = 0; i < 10 && (await tabs.list()).some(t => t.id === zip.id); i++) await sleep(300)
if ((await tabs.list()).some(t => t.id === zip.id)) { const zt = await tree({}); const dlg = (zt.match(/^OVERLAY: "([^"]{0,80})/m) || [])[1] || ''; try { await tabs.close(zip.id) } catch (e) {} return { ...R, note: '우편번호 팝업 저장이 안 닫힘' + (dlg ? '(' + dlg + ')' : '') + (dtlText ? '' : ' — 상세주소 없음') } }
await tabs.switch(form.id)
await sleep(500)
const nmId = await first('#rcptpeNm, input[name="rcptpeNm"]')
if (nmId < 0) return { ...R, note: '받는분 이름칸 없음' }
await page.type(nmId, nz(args.name), false)
let h1 = await first('#hpno1')
if (h1 < 0) h1 = parseInt((((await tree({ interactive: true })).split('\n').find(l => /combobox "010 011/.test(l))) || '[-1]').slice(1))
if (h1 >= 0) await page.select(h1, '010')
let h2 = await first('#hpno2')
if (h2 < 0) h2 = await page.idOf('- 없이 번호만 입력해주세요.', 0) // 첫 칸이 휴대폰(둘째는 일반전화)
if (h2 < 0) return { ...R, note: '휴대폰 번호칸 없음' }
R.phone_field_ids = [h2]
const tr = await tree({ interactive: true })
const lines = tr.split('\n')
const val = id => ((lines.find(l => l.startsWith('[' + id + ']')) || '').match(/value="([^"]*)"/) || [])[1] || ''
R.name = val(nmId) || null
const vals = lines.filter(l => /textbox/.test(l) && !l.startsWith('[' + nmId + ']')).map(l => (l.match(/value="([^"]*)"/) || [])[1]).filter(v => v && v.length >= 2)
R.address = vals.find(v => /(로|길)\s*\d|(동|읍|면|리)\s+\d/.test(v)) || null
R.postal_code = vals.find(v => /^\d{5}$/.test(v)) || null
R.address_detail = (args.address_detail && vals.find(v => v.startsWith(nz(args.address_detail)))) || null
R.ok = !!(R.name && R.address)
if (!R.ok) R.note = '폼 되읽기 실패(이름 또는 주소)'
return R