// H몰 같은 상품 찾기(2026-09-27, 교차 비교용): SSG 같은 다른 사이트 상품을 열지 않고(PerimeterX) 모델코드로 다나와를 검색해
// 가격비교 상품의 현대H몰(ED907) 줄 → 다나와 이동 링크로 H몰에 도착해 상품번호·상품명·제휴(ReferCode)를 확인한다.
// 도착 상품명에 모델코드가 있는 첫 후보만 같은 상품으로 본다. 결제·장바구니 없음.
// 인자 {model?, name?(상품명 — model 이 없으면 여기서 모델코드), source_url?(쓰지 않는다), option?, profile?}
// 반환 {found, product_url, name, model, slitmCd, entry_url, affiliate, candidates, note}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const key = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const pf = args.profile ? { profile: args.profile } : {}
const R = { found: false, product_url: null, name: null, model: null, slitmCd: null, entry_url: null, affiliate: null, candidates: [], note: null }
const model = nz(args.model || (String(args.name || '').match(/\b[A-Z]{1,4}\d{3,6}[A-Z0-9]{0,4}(?:[ _-]\d{3})?\b/) || [])[0])
if (!model) return { ...R, note: 'model 필요(예: HF5441-100)' }
const lines = t => t.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const open = async url => { const id = (String(await tabs.open({ ...pf, url })).match(/tab (\S+)/) || [])[1]; if (id) await tabs.switch(id); return id }
const close = async id => { if (id) { try { await tabs.close(id) } catch (e) {} } }
let tid = await open('https://search.danawa.com/dsearch.php?query=' + encodeURIComponent(model))
try { await page.waitFor(/가격비교|검색결과|최저가/, 12000) } catch (e) {}
const found = lines((await page.get({ selector: 'a[href*="pcode="]' })).tree)
const pcodes = []
for (const l of found) {
  const m = l.match(/^\[\d+\] link "([^"]*)" href=https:\/\/prod\.danawa\.com\/info\/\?pcode=(\d+)/)
  if (m && key(m[1]).includes(key(model)) && !pcodes.includes(m[2])) pcodes.push(m[2])
}
if (!pcodes.length) { await close(tid); return { ...R, error: 'no_danawa', note: '다나와 검색 결과에 모델코드 상품 없음: ' + model } }
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
R.model = model
// 후보마다 이동 링크로 H몰에 도착해 본다(앞 2개) — 도착 상품번호가 같고 상품명에 모델코드가 있어야 같은 상품
for (const c of R.candidates.slice(0, 2)) {
  const url = 'https://prod.danawa.com/bridge/loadingBridge.html?pcode=' + c.pcode + '&cmpnyc=ED907&link_pcode=' + c.slitmCd + '&keyword=' + encodeURIComponent(model)
  tid = await open(url)
  for (let i = 0; i < 20 && !/hmall\.com/.test(await page.url()); i++) await sleep(700)
  const landed = await page.url()
  const name = nz(String(await page.title()).replace(/\s*-\s*현대Hmall\s*$/, ''))
  await close(tid)
  const got = (landed.match(/slitmCd=(\d+)/) || [])[1]
  if (got !== c.slitmCd || !key(name).includes(key(model))) { R.note = `후보 ${c.slitmCd} 불일치: ${name.slice(0, 40)}`; continue }
  return { ...R, found: true, note: null, slitmCd: got, name, entry_url: url, affiliate: (landed.match(/[?&]ReferCode=(\d+)/) || [])[1] || null, product_url: 'https://www.hmall.com/md/pda/itemPtc?slitmCd=' + got }
}
return R
