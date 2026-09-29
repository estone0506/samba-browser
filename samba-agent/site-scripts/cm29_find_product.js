// 29CM 같은 상품 찾기(교차 비교, 2026-09-26 재작성) — source_url(무신사 등 다른 쇼핑몰 상품)을 이 스크립트가 연 탭에서 읽어
// 품번(모델코드)을 얻고, 29CM 검색 결과 중 이름에 같은 품번이 든 상품을 고른다. 예전 판은 이미 열린 탭(가장 최근 것)을 뒤졌다.
// 품번이 없으면 검색 결과가 하나뿐이고 상품명이 같을 때만 같은 상품으로 본다 — 다른 상품을 같은 것으로 치지 않는다.
// 결제·장바구니는 누르지 않는다. args: source_url, option  반환 {found, product_url, name, model, note}
const lines = t => t.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d/.test(l))
const nameOf = l => (l.match(/^\[\d+\] \w+ "([^"]*)"/) || [])[1]
const N = s => String(s || '').toLowerCase().replace(/[\s\-_/:().,[\]·']/g, '')
const open = async url => { const id = (String(await tabs.open({ url })).match(/tab (\S+)/) || [])[1]; if (id) await tabs.switch(id); return id }
const src = String(args.source_url || '').trim()
const none = (note, model) => ({ found: false, product_url: '', name: '', model: model || '', note })
if (!/^https?:/.test(src)) return none('source_url 없음')
let tid = await open(src)
await page.waitFor(/품번|모델|구매하기/, 10000).catch(() => {})
let t = ''
for (let i = 0; i < 6; i++) { t = (await page.get({})).tree; if (/품번|모델번호|스타일\s*넘버/.test(t)) break; await sleep(300) }
await tabs.close(tid).catch(() => {})
const title = ((t.match(/TITLE:\s*(.*)/) || [])[1] || '').replace(/\s*[-|]\s*사이즈.*$|\s*\|.*$/, '').trim()
const tx = (t.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const model = ((tx.match(/(?:품번|모델번호|스타일\s*넘버|제품번호)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_]{3,})/) || title.match(/\/\s*([A-Za-z0-9]+[-_][A-Za-z0-9\-_]+)\s*$/) || [])[1] || '').trim()
const brand = (title.match(/^([^\s(]+)/) || [])[1] || ''
const core = title.replace(/^[^\s(]+(\([^)]*\))?\s*/, '').split(/\s[-/]\s/)[0].trim()
tid = await open('https://www.29cm.co.kr/store/search?keyword=' + encodeURIComponent(model || (brand + ' ' + core).trim()))
await page.waitFor(/catalog\/\d+|검색 결과가 없/, 8000).catch(() => {})
await sleep(300)
const hits = lines((await page.get({ selector: 'a[href*="catalog/"]' })).tree)
  .map(l => ({ n: nameOf(l), no: (l.match(/catalog\/(\d+)/) || [])[1] })).filter(h => h.no && h.n && !/^[\d,]+$/.test(h.n) && !/무료배송|도착/.test(h.n))
await tabs.close(tid).catch(() => {})
let hit = null
if (model && N(model).length >= 5) hit = hits.find(h => N(h.n).includes(N(model)))
else {
  const nos = [...new Set(hits.map(h => h.no))]
  if (nos.length === 1 && N(core).length >= 4 && N(hits[0].n).includes(N(core))) hit = hits[0]
}
if (!hit) return none(model ? '품번 ' + model + ' 이 든 29CM 상품 없음(검색 ' + hits.length + '건)' : '품번 없음 — 이름만으로 하나로 못 정함', model)
return { found: true, product_url: 'https://www.29cm.co.kr/products/' + hit.no, name: hit.n, model, note: null }
