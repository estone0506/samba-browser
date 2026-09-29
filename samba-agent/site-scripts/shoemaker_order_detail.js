// 슈마커 주문 상세(마이페이지 주문/배송조회 → 주문 상세 내역)에서 source_order_no 주문의 결제 값을 읽는다.
// 원가 규칙(사용자 확정 2026-09-26): 포인트 사용 더하고 포인트 적립 뺀다. 슈머니 사용은 할인, 슈머니 적립은 원가에 넣지 않는다.
// 2026-09-26 보강: 연 탭으로 옮겨 읽고 끝나면 닫는다(탭이 쌓이지 않게). 고정 sleep → 목록·상세가 뜰 때까지 폴링.
// 반환 {source_order_no,status,paid,points_used,reward,points_reward,shoemoney_used,card}
const lines = s => s.tree.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const text = async () => ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const num = s => s ? parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0 : 0
const tabId = r => (String(r).match(/tab (\S+)/) || [])[1] || null
const until = async (fn, ms) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(250) } }
const no = String(args.source_order_no || args.orderNo || '').trim()
const empty = note => ({ source_order_no: no || null, status: '', paid: 0, points_used: 0, reward: 0, card: '', note })
if (!no) return empty('no order number')
if (!/^[A-Za-z0-9-]+$/.test(no)) return empty('bad order number')

const tid = tabId(await tabs.open({ ...(args.profile ? { profile: args.profile } : {}), url: 'https://www.shoemarker.co.kr/ASP/Mypage/OrderList.asp' }))
if (tid) await tabs.switch(tid)
try {
  await page.waitFor('주문내역', 8000)
  // 목록 줄: link "주문일 : 2026-09-26 (C000XXXXXXX)" href=javascript:getOrderDetail(NNNNNNN); — 주소에 주문번호가 없어
  // 예전 판(a[href*=주문번호])은 늘 'order not found' 였다(실기 2026-09-26). 링크 글자로 찾는다
  const find = async () => lines(await page.get({ selector: 'a[href*="getOrderDetail"]' })).find(l => l.includes('(' + no + ')'))
  // 기본 1개월 — 없으면 6개월로 넓힌다
  // 목록 줄은 머리글보다 늦게 그려진다 — 주문 줄(getOrderDetail)이 보일 때까지 기다린 뒤 찾는다
  await until(async () => /getOrderDetail|주문내역이 없/.test((await page.get({})).tree), 5000)
  let open = await find()
  if (!open) {
    const six = await page.idOf('6개월')
    if (six >= 0) { await page.click(six); open = await until(find, 8000) }
  }
  if (!open) return empty('order not found in list')
  await page.click(parseInt(open.slice(1)))
  // 상세가 이 주문번호와 결제금액까지 그려질 때까지
  const d = await until(async () => {
    const t = await text(), i = t.indexOf('주문 상세 내역'), s = i >= 0 ? t.slice(i, i + 1500) : ''
    return s.includes(no) && /총 결제금액 [\d,]+/.test(s) && s
  }, 8000)
  if (!d) return empty('detail not shown')
  const paid = num((d.match(/총 결제금액 ([\d,]+) ?원/) || [])[1])
  // 원가 규칙: 포인트 사용은 더하고(points_used), 슈머니 사용은 할인이라 되더하지 않는다(참고로만 shoemoney_used).
  // 적립은 포인트만 뺀다(슈머니 적립은 원가에 넣지 않는다)
  const points_used = num((d.match(/포인트사용 : ([\d,]+)/) || [])[1])
  const shoemoney_used = num((d.match(/슈머니사용 : ([\d,]+)/) || [])[1])
  const points_reward = num((d.match(/적립예정 포인트 ([\d,]+) ?원/) || [])[1])
  const status = (d.match(/현재 (\S+?) 단계/) || [])[1] || ''
  const method = ((d.match(/결제수단 (\S+)/) || [])[1] || '').trim()
  // 슈마커페이(간편결제)는 등록한 현대카드로 결제된다 — 청구할인 계산이 카드사를 보게 붙인다
  const card = /슈마커페이|간편결제/.test(method) ? '슈마커페이 현대카드' : method
  return { source_order_no: no, status, paid, points_used, reward: points_reward, points_reward, shoemoney_used, card }
} finally {
  if (tid) { try { await tabs.close(tid) } catch (e) {} }
}
