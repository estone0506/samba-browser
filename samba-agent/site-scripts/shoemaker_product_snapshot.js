// 슈마커(PC) 상품 스냅샷 — 사이즈를 골라 바로구매로 주문서까지 연다(결제 없음).
// 모바일 판(m.shoemarker)은 하네스 형식과 달라 PC 로 새로 썼다(2026-09-26).
// 2026-09-26 보강(다른 주문 주문서 결제 사고 방지):
//  - 하네스의 주문서 탭 정리(_close_order_tabs)는 슈마커 주소(/ASP/Order/Order.asp)를 못 알아본다 — 새 주문서를 열기 전에
//    이 레인의 슈마커 주문서 탭을 닫아, 뒤 단계(정돈·견적·배송지·결제 진입)가 볼 주문서를 하나로 만든다(args.keepOrderTabs 면 안 닫음)
//  - 주문서의 ProductCode·사이즈를 되읽어 고른 것과 다르면 error:'order_form_mismatch'. 주문서 탭 id 를 order_tab 으로 돌려준다
//  - 중복 확인 뒤 '가장 최근 주문서 탭'이 아니라 이 스냅샷이 연 탭으로 돌아간다
// 반환 {options,already_ordered,existing_order_no,coupons,methods,cost,reward,margin_pct,product_url,selected,order_tab,order_item} · 로그인 안 됨이면 error:'login_required'
const H = 'https://www.shoemarker.co.kr'
const OF = /shoemarker\.co\.kr\/ASP\/Order\/Order\.asp/i
const tabId = r => (String(r).match(/tab (\S+)/) || [])[1] || null
const lines = s => s.tree.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const text = async () => ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const num = s => s ? parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0 : 0

// 주문 옵션(예: 'EU 블랙 화이트 EU 45 · KR 290')을 화면 사이즈(290)와 맞춘다 — KR 숫자 우선, 숫자가 다르면 고르지 않는다
function pickOption(want, opts) {
  if (!want || !opts.length) return null
  if (opts.includes(want)) return want
  const w = want.toLowerCase()
  const kr = w.match(/kr\s*(\d+(?:\.\d+)?)/)
  const nums = (w.match(/\d+(?:\.\d+)?/g) || []).map(Number)
  for (const n of kr ? [Number(kr[1]), ...nums.reverse()] : nums.reverse()) {
    const hit = opts.find(o => { const m = String(o).match(/\d+(?:\.\d+)?/); return m && Number(m[0]) === n })
    if (hit) return hit
  }
  return null
}

const sku = String(args.sku || '').trim()
const want = String(args.size || '').trim()
const code = (sku.match(/ProductCode=(\d+)/) || [])[1] || (/^\d{4,6}$/.test(sku) ? sku : null)
const url = code ? `${H}/ASP/Product/ProductDetail.asp?ProductCode=${code}` : `${H}/ASP/Product/SearchProductList.asp?SearchWord=${encodeURIComponent(sku)}`
if (!args.keepOrderTabs) for (const x of await tabs.list()) if (OF.test(x.url || '')) { try { await tabs.close(x.id) } catch (e) {} }
const opened = await tabs.open({ ...(args.profile ? { profile: args.profile } : {}), url })
const tid = tabId(opened)
if (tid) await tabs.switch(tid)
await page.waitFor(code ? '바로구매' : '검색', 8000)
if (!code) {
  const m = lines(await page.get({ selector: 'a[href*="ProductDetail.asp"]' }))[0]
  if (!m) return { options: [], error: 'no_product', note: 'search no result' }
  await page.click(parseInt(m.slice(1)))
  await page.waitFor('바로구매', 8000)
}
const product_url = await page.url()
const pcode = code || (product_url.match(/ProductCode=(\d+)/i) || [])[1] || null

// 사이즈: 품절(disabled)도 '290 [품절]' 로 options 에 넣는다(하네스 sold_out_option_listed 가 확정 품절로 본다) — 고를 때만 뺀다
const labelOf = l => (l.match(/"([^"]+)"/) || [])[1]
const all = lines(await page.get({ selector: 'label.chk-size' })).map(l => ({ id: parseInt(l.slice(1)), t: labelOf(l) })).filter(o => o.t)
const soldIds = new Set(lines(await page.get({ selector: 'input[name=chk-size]:disabled + label' })).map(l => parseInt(l.slice(1))))
const avail = all.filter(o => !soldIds.has(o.id))
const options = all.map(o => soldIds.has(o.id) ? o.t + ' [품절]' : o.t)
const skip = note => ({ options, already_ordered: null, coupons: {}, methods: [], cost: null, margin_pct: null, product_url, selected: null, note })
// 주문 사이즈(args.size)가 없을 때만 남은 선택지 하나를 고른다(주문 사이즈가 품절이면 다른 걸 사지 않는다)
const picked = pickOption(want, avail.map(o => o.t)) || (!want && avail.length === 1 ? avail[0].t : null)
if (!picked) return skip(all.length ? `size not available: ${want}` : 'no size options')
// 라벨을 누르면 숨은 라디오의 onclick(selectProduct)이 돈다 — 리뷰 팝업이 덮어도 DOM 클릭이라 닿는다.
// 라디오가 숨어 선택 상태를 못 읽어 짧게만 기다린다
await page.click(avail.find(o => o.t === picked).id)
// 선택이 반영돼 총 금액이 0원이 아니게 될 때까지 기다린다 — 0.5초만 기다리면 주문서에 상품이 안 실렸다(실기 2026-09-28 키즈 220)
try { await page.waitFor(/총 금액 [1-9][\d,]*원/, 6000) } catch (e) { await sleep(1500) }

const buy = lines(await page.get({ selector: 'button[onclick*="addOrderSheet"]' }))[0]
if (!buy) return skip('buy button not found')
await page.click(parseInt(buy.slice(1)))
await page.waitFor('최종 주문금액', 10000)
const orderUrl = await page.url()
if (/Login/i.test(orderUrl)) return { ...skip('로그인 필요'), error: 'login_required' }
if (!OF.test(orderUrl)) return { ...skip('주문서로 못 감: ' + orderUrl.slice(0, 80)), error: 'no_checkout' }

const tr = (await page.get({})).tree
const t = (tr.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const sms = [...t.matchAll(/\[([^\]]+)\] 사이즈 : (\S+) 수량 : (\d+)/g)]
const sm = sms[0]
const selected = sm ? sm[2] : null
// 주문서 되읽기 대조: 상품 줄 하나, ProductCode·사이즈가 고른 것과 같아야 한다
const codes = [...new Set([...tr.matchAll(/ProductDetail\.asp\?ProductCode=(\d+)/gi)].map(m => m[1]))]
const order_item = sm ? `${sm[1]} ${sm[2]} (${codes.join(',')})` : null
const bad = sms.length !== 1 ? `order items ${sms.length}` : pcode && !(codes.length === 1 && codes[0] === pcode) ? `ProductCode ${codes} != ${pcode}` : !(selected === picked || (num(selected) > 0 && num(selected) === num(picked))) ? `size ${selected} != ${picked}` : null
if (bad) return { ...skip('주문서 불일치: ' + bad), selected, order_tab: tid, error: 'order_form_mismatch' }
const cost = num((t.match(/최종 주문금액 ([\d,]+) ?원/) || [])[1]) || null
// 원가 규칙: 슈머니 적립은 원가에 넣지 않는다(사용자 확정) — 포인트 적립만
const reward = num((t.match(/포인트적립 ([\d,]+) ?원/) || [])[1])
// 주문내역과 대조할 상품명 끝부분(주문서 'NIKE 코트비전 로우 [IB2998-004]' → 주문내역 'NIKE 코트비전 로우 사이즈 : 290')
const at = sm ? t.indexOf(sm[0]) : -1
const nameTail = at > 0 ? t.slice(Math.max(0, at - 13), at).trim() : ''

// 중복: 최근 3일 주문내역에 같은 상품·같은 사이즈가 있고 취소되지 않았으면 이미 산 것
// 주문내역을 못 읽으면 false 가 아니라 null + note
let already_ordered = null
let existing_order_no = null
let dup_note = 'dup check skipped: order item unreadable'
if (nameTail && selected) {
  const o2 = await tabs.open({ ...(args.profile ? { profile: args.profile } : {}), url: `${H}/ASP/Mypage/OrderList.asp` })
  const t2 = tabId(o2)
  if (t2) await tabs.switch(t2)
  await page.waitFor('주문내역', 8000)
  const ol = await text()
  const bks = ol.split('주문일 : ').slice(1)
  // 주문이 하나도 없으면 '없습니다' 문구가 있어야 읽은 것으로 본다
  if (/Login/i.test(await page.url()) || !ol.includes('주문내역') || !(bks.length || /없습니다/.test(ol))) dup_note = 'order list unreadable'
  else { already_ordered = false; dup_note = null }
  for (const bk of already_ordered === false ? bks : []) {
    const d = bk.match(/^(\d{4}-\d\d-\d\d) \(([A-Z0-9]+)\)/)
    if (!d) continue
    const age = Date.now() - new Date(d[1] + 'T00:00:00+09:00').getTime()
    const head = bk.slice(0, 160)
    if (age < 3 * 864e5 && head.includes(nameTail + ' 사이즈 : ' + selected) && !/취소완료|취소접수/.test(head)) {
      already_ordered = true
      existing_order_no = d[2]
      break
    }
  }
  if (t2) await tabs.close(t2)
  // 이 스냅샷이 연 주문서 탭으로 돌아간다('가장 최근 주문서 탭' 금지)
  if (tid) await tabs.switch(tid)
}

const methods = ['슈마커 간편결제', '네이버페이', '페이코']
return { options, already_ordered, existing_order_no, coupons: {}, methods, cost, reward, margin_pct: null, product_url, selected, order_tab: tid, order_item, note: dup_note }
