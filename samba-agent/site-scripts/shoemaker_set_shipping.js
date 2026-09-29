// 슈마커 주문서 배송지 — 신규 배송지로 이름·주소를 넣는다. 전화 칸은 비워 두고 번호는 하네스(키마스터)가 채운다.
// 주소 검색 창(카카오 우편번호)은 2단 iframe 이라 화면으로는 못 누른다 — 같은 검색 페이지를 탭으로 열어
// 우편번호·주소를 읽고 주문서 칸에 직접 넣는다(2026-09-26). 전화: 010 은 고르는 칸, 나머지 8자리 한 칸 → phone-rest.
// 2026-09-26 보강: 주문서 탭은 공통 규칙으로 하나만(맞는 게 없으면 {ok:false, note:'order form mismatch'}). 고정 sleep 을 줄였다.
// 반환 {name,address,zip,phone_field_ids,phone_formats,order_tab}
const lines = s => s.tree.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const idOf = l => parseInt(l.slice(1))
const tabId = r => (String(r).match(/tab (\S+)/) || [])[1] || null
const field = async n => { const l = lines(await page.get({ selector: '[name=' + n + ']' }))[0]; return l ? idOf(l) : -1 }
const valueOf = async n => { const l = lines(await page.get({ selector: '[name=' + n + ']' }))[0] || ''; return (l.match(/value="([^"]*)"/) || [])[1] || '' }
// --- 주문서 탭(공통): '가장 최근 탭' 금지(2026-09-26 사고). args.tab > args.expect{name,option,selected,product_url}·args.product_url 대조 > 탭 하나뿐 ---
const OF = /shoemarker\.co\.kr\/ASP\/Order\/Order\.asp/i
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SZ = /(?<![\d.])\d{2,3}(?:\.5)?(?![\d.])/g
// 흔한 말(하네스 payer._GENERIC_WORDS)
const GEN = new Set('매장정품 정품 신발 운동화 스니커즈 스니커 남성 여성 남녀공용 공용 커플 키즈 아동 나이키 아디다스 뉴발란스 푸마 반스 컨버스 리복 아식스 휠라 NIKE ADIDAS PUMA VANS CONVERSE REEBOK ASICS FILA 블랙 화이트 그레이 네이비 BLACK WHITE GREY GRAY NAVY'.split(' '))
// 상품 줄: link "NIKE 코트비전 로우 [IB2998-004]" href=…ProductCode=48761 · '… 사이즈 : 280 수량 : 1'
async function formInfo() {
  const tr = (await page.get({})).tree, tx = (tr.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' '), seen = new Set()
  const items = tr.split('PAGE TEXT')[0].split('\n').map(l => l.match(/^\[\d+\] link "([^"]*\[[\w-]+\])" href=\S*ProductCode=(\d+)/i)).filter(m => m && !seen.has(m[0].replace(/^\[\d+\]/, '')) && seen.add(m[0].replace(/^\[\d+\]/, ''))).map(m => {
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
  // 대조 근거가 없으면 탭이 하나일 때만
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
// --- 공통 끝 ---
const name = String(args.name || '').trim()
const addr = String(args.address || '').replace(/\s+/g, ' ').trim()
const detail = String(args.address_detail || '').replace(/\s+/g, ' ').trim()
if (!name || !addr) throw new Error('name/address required')
// 상세가 주소를 다시 담아 오기도 한다('인천광역시 서구 원창동' + '인천광역시 서구 원창동 488 로지스허브 …')
const full = detail.startsWith(addr) ? detail : (addr + ' ' + detail).trim()
// 검색어 = 첫 번지 숫자(12, 12-3)까지, 나머지는 상세주소
const cut = full.match(/^(.*?\s\d+(?:-\d+)?)(?:\s|$)(.*)$/)
const query = cut ? cut[1] : addr
const rest = cut ? cut[2].trim() : detail

// 0) 이 주문의 주문서 탭(입력 전에 고른다 — 다른 주문 주문서에 배송지를 넣지 않는다)
const F = await pickForm()
if (F.err) return { ok: false, note: F.err, why: F.why || null }

// 1) 우편번호 조회
const o = await tabs.open({ url: 'https://postcode.map.kakao.com/search?origin=' + encodeURIComponent('https://www.shoemarker.co.kr') + '&region_name=' + encodeURIComponent(query) })
const pt = tabId(o)
if (pt) await tabs.switch(pt)
// 결과 목록이 뜨면 바로(없으면 최대 6초)
await page.waitFor('기초구역번호', 6000)
const res = ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
if (pt) await tabs.close(pt)
const hits = res.split('기초구역번호(새 우편번호) ').slice(1).map(b => ({
  zip: (b.match(/^(\d{5})/) || [])[1],
  // 도로명으로 찾으면 '도로명 … 지 번 …' 순서에 '지 번'이 띄어져 나온다(실기 2026-09-26) — 둘 다 끊는다
  jibun: (b.match(/지 ?번 (.+?) (?:도로명|주소 영문보기)/) || [])[1],
  road: (b.match(/도로명 (.+?) (?:주소 영문보기|지 ?번)/) || [])[1]
})).filter(h => h.zip)
// 하네스가 우편번호를 주면 그 번호의 결과만 — 없으면 엉뚱한 주소를 넣지 않고 멈춘다
const pc = String(args.postal_code || '').replace(/\D/g, '')
const hit = pc ? hits.find(h => h.zip === pc) : hits[0]
if (!hits.length) throw new Error('no address result for: ' + query)
if (!hit) return { ok: false, note: 'zip mismatch', why: `${pc} not in ${hits.map(h => h.zip).slice(0, 5)}`, order_tab: F.id }
// 지번으로 찾았으면 지번을, 도로명으로 찾았으면 도로명을 쓴다(되읽기 대조가 넣은 주소와 맞게)
const line1 = /(로|길)\s*\d/.test(query) ? (hit.road || hit.jibun) : (hit.jibun || hit.road)

// 2) 주문서 입력 — 고른 탭으로 돌아가 그 탭인지 확인한다
await tabs.switch(F.id)
if (!OF.test(await page.url())) return { ok: false, note: 'order form mismatch', why: 'order tab moved' }
const nb = lines(await page.get({ selector: '[onclick*="setReceiveInfo"]' })).find(l => /신규 배송지/.test(l))
// 신규 배송지 버튼이 없으면 기존 배송지 칸을 덮어쓰게 되므로 멈춘다
if (!nb) return { ok: false, note: 'new address button not found', order_tab: F.id }
await page.click(idOf(nb)); await sleep(400)
await page.type(await field('AddressName'), name, false)
await page.type(await field('ReceiveName'), name, false)
await page.type(await field('ReceiveZipCode'), hit.zip, false)
await page.type(await field('ReceiveAddr1'), line1, false)
await page.type(await field('ReceiveAddr2'), rest, false)
if (args.memo) await page.type(await field('Memo'), String(args.memo), false)
const hp1 = await field('ReceiveHP1')
if (hp1 >= 0) await page.select(hp1, '010')
const hp23 = await field('ReceiveHP23')

const a1 = await valueOf('ReceiveAddr1')
const a2 = await valueOf('ReceiveAddr2')
return {
  name: await valueOf('ReceiveName'),
  address: (a1 + ' ' + a2).trim(),
  zip: await valueOf('ReceiveZipCode'),
  phone_field_ids: hp23 >= 0 ? [hp23] : [],
  phone_formats: ['phone-rest'],
  order_tab: F.id
}
