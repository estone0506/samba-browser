// H몰 다나와 진입 경로(2026-09-27): 사용자 규칙 — H몰은 반드시 다나와 가격비교를 거쳐 들어간다(도착 ReferCode=250 이면 제휴할인).
// 다나와에서 모델코드 검색 → 가격비교 상품(pcode) → 판매처 현대H몰(업체코드 ED907) 줄의 H몰 상품번호(linkProductSeq)
// → 다나와 이동 링크(loadingBridge) 주소를 만든다. check 면 그 링크를 프로필 탭으로 열어 도착한 H몰 slitmCd·상품명을 확인하고 닫는다.
// 인자 {model: 'HF5441-100', name?, slitmCd?(주문 링크의 H몰 번호 — 있으면 그 줄만), profile?, check?: true}
// 반환 {ok, entry_url, pcode, slitmCd, candidates:[{pcode, slitmCd}], landed_url, landed_name, affiliate, error?, note}
//  error: no_model · no_danawa(검색 결과 없음) · no_hmall_row(현대H몰 판매처 없음) · not_listed(그 상품번호 줄 없음) · landed_mismatch
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const key = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const pf = args.profile ? { profile: args.profile } : {}
const R = { ok: false, entry_url: null, pcode: null, slitmCd: null, candidates: [], landed_url: null, landed_name: null, affiliate: null, note: null }
const model = nz(args.model || (String(args.name || '').match(/\b[A-Z]{1,4}\d{3,6}[A-Z0-9]{0,4}(?:[ _-]\d{3})?\b/) || [])[0])
if (!model) return { ...R, error: 'no_model', note: 'model 필요(예: HF5441-100)' }
const lines = t => t.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const open = async url => { const id = (String(await tabs.open({ ...pf, url })).match(/tab (\S+)/) || [])[1]; if (id) await tabs.switch(id); return id }
const close = async id => { if (id) { try { await tabs.close(id) } catch (e) {} } }
// 1) 다나와 검색 — 이름에 모델코드가 들어간 가격비교 상품(pcode)
let tid = await open('https://search.danawa.com/dsearch.php?query=' + encodeURIComponent(model))
try { await page.waitFor(/가격비교|검색결과|최저가/, 12000) } catch (e) {}
const found = lines((await page.get({ selector: 'a[href*="pcode="]' })).tree)
const pcodes = []
for (const l of found) {
  const m = l.match(/^\[\d+\] link "([^"]*)" href=https:\/\/prod\.danawa\.com\/info\/\?pcode=(\d+)/)
  if (m && key(m[1]).includes(key(model)) && !pcodes.includes(m[2])) pcodes.push(m[2])
}
if (!pcodes.length) { await close(tid); return { ...R, error: 'no_danawa', note: '다나와 검색 결과에 모델코드 상품 없음: ' + model } }
// 2) 상품 페이지마다 현대H몰(ED907) 줄의 H몰 상품번호 — 리뷰 링크 companyCode=ED907&linkProductSeq=N 에 실려 있다
for (const pc of pcodes.slice(0, 3)) {
  await close(tid)
  tid = await open('https://prod.danawa.com/info/?pcode=' + pc + '&keyword=' + encodeURIComponent(model))
  try { await page.waitFor(/쇼핑몰별 최저가|가격비교/, 12000) } catch (e) {}
  const t = String((await page.get({ query: 'companyCode=ED907' })).tree)
  const seqs = [...new Set([...t.matchAll(/companyCode=ED907&linkProductSeq=(\d+)/g)].map(m => m[1]))]
  for (const s of seqs) R.candidates.push({ pcode: pc, slitmCd: s })
}
await close(tid)
if (!R.candidates.length) return { ...R, error: 'no_hmall_row', note: '다나와 가격비교에 현대H몰 판매처 없음' }
const want = String(args.slitmCd || '').replace(/\D/g, '')
const pick = want ? R.candidates.find(c => c.slitmCd === want) : R.candidates[0]
if (!pick) return { ...R, error: 'not_listed', note: `다나와 현대H몰 줄에 상품번호 ${want} 없음` }
R.pcode = pick.pcode
R.slitmCd = pick.slitmCd
R.entry_url = 'https://prod.danawa.com/bridge/loadingBridge.html?pcode=' + pick.pcode + '&cmpnyc=ED907&link_pcode=' + pick.slitmCd + '&keyword=' + encodeURIComponent(model)
if (!args.check) { R.ok = true; return R }
// 3) 확인: 이동 링크 → H몰 도착(slitmCd·ReferCode·상품명)
tid = await open(R.entry_url)
for (let i = 0; i < 20 && !/hmall\.com/.test(await page.url()); i++) await sleep(700)
R.landed_url = await page.url()
R.affiliate = (R.landed_url.match(/[?&]ReferCode=(\d+)/) || [])[1] || null
R.landed_name = nz(String(await page.title()).replace(/\s*-\s*현대Hmall\s*$/, ''))
await close(tid)
const got = (R.landed_url.match(/slitmCd=(\d+)/) || [])[1]
R.ok = got === R.slitmCd && key(R.landed_name).includes(key(model))
if (!R.ok) { R.error = 'landed_mismatch'; R.note = `도착 불일치: slitmCd ${got}, 이름 ${R.landed_name.slice(0, 40)}` }
else if (!R.affiliate) { R.ok = false; R.error = 'no_affiliate'; R.note = '도착 주소에 ReferCode 없음' }
return R
