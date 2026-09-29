// SSG 신세계몰 같은 상품 찾기(2026-09-27): 사용자 규칙 — SSG 주문은 신세계몰(6004)·신세계백화점(6009) 상품으로만 산다(이마트 등 금지).
// 주문 링크가 신세계백화점(department, 6009)·SSG.COM 이면 신세계몰 검색(shinsegaemall.ssg.com/search.ssg?query=모델)에서 같은 모델코드 상품을 모은다.
// 결제·주문 없음. 가격은 검색 목록 표시가(쿠폰 전/후 섞임) — 실제 원가는 ssg_product_snapshot 으로 주문서에서 본다.
// 인자 {model: 'HF5441-100'|'YUA24B06', color?: 색상 코드·이름('Z1','Black','100'), profile?, limit?}
// 반환 {ok, model, items:[{item_id, url, name, price, color_ok}], note}  (가격 오름차순, color 를 주면 color_ok 우선)
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const key = s => String(s || '').toUpperCase().replace(/[\s_\-]/g, '')
const model = nz(args.model)
if (!model) return { ok: false, items: [], note: 'model 필요' }
const pf = args.profile ? { profile: args.profile } : {}
const id = (String(await tabs.open({ ...pf, url: 'https://shinsegaemall.ssg.com/search.ssg?target=all&query=' + encodeURIComponent(model) })).match(/tab (\S+)/) || [])[1]
if (id) await tabs.switch(id)
try { await page.waitFor(/판매가격|검색결과/, 12000) } catch (e) {}
await sleep(1000)
const g = await page.get({ selector: 'a[href*="itemView.ssg"]' })
const tree = typeof g === 'string' ? '' : g.tree
if (id) { try { await tabs.close(id) } catch (e) {} }
const seen = new Map()
for (const l of tree.split('\n')) {
  const m = l.match(/^\[\d+\] link "([^"]+)" href=(\S+)/)
  if (!m) continue
  const href = m[2]
  const item = (href.match(/itemId=(\d+)/) || [])[1]
  const site = (href.match(/siteNo=(\d+)/) || [])[1] || (/department\.ssg\.com/.test(href) ? '6009' : /shinsegaemall\.ssg\.com/.test(href) ? '6004' : '')
  // 허용 몰: 신세계몰 6004 · 신세계백화점 6009(6009는 allow_department:true 때만)
  if (!item || !(site === '6004' || (site === '6009' && args.allow_department === true)) || seen.has(item)) continue
  const name = nz(m[1].replace(/(최고판매가|정상가격|판매가격|할인율|쿠폰할인).*$/, ''))
  if (!key(m[1]).includes(key(model))) continue
  const price = num((m[1].match(/판매가격\s*([\d,]+)원/) || [])[1]) || null
  const color = nz(args.color)
  const color_ok = color ? key(m[1]).includes(key(color)) : null
  seen.set(item, { item_id: item, site_no: site, url: (site === '6009' ? 'https://department.ssg.com' : 'https://shinsegaemall.ssg.com') + '/item/itemView.ssg?itemId=' + item + '&siteNo=' + site, name: name.slice(0, 80), price, color_ok })
}
const items = [...seen.values()].sort((a, b) => (b.color_ok === true) - (a.color_ok === true) || (a.price || 1e7) - (b.price || 1e7)).slice(0, Number(args.limit) || 10)
return { ok: items.length > 0, model, items, note: items.length ? null : '신세계몰에 같은 모델 상품 없음' }
