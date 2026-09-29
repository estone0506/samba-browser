
const no = String(args.source_order_no || args.orderNo || '')
const num = s => Number(String(s).replace(/[^\d]/g, '') || 0)

// 주문 상세 페이지 확보 (열려 있으면 그 탭, 없으면 새로 연다)
const detailUrl = 'https://www.musinsa.com/order/order-detail/' + no
let list = await tabs.list()
let tab = (list || []).find(t => String(t.url || '').includes('order-detail/' + no))
if (tab) { await tabs.switch(tab.id) } else {
  await tabs.open({ url: detailUrl, profile: args.profile })
}
let tree = ''
for (let i = 0; i < 12; i++) {
  await sleep(1200)
  const r = await page.get({})
  tree = r.tree || ''
  if (/결제 정보|결제 금액/.test(tree)) break
}
const text = (tree.split('PAGE TEXT:')[1] || tree).replace(/\s+/g, ' ')
// 화면의 클릭 가능한 문구(광고 배너 등) 모음 — 결제수단 추출 때 걸러낸다
const clicks = []
for (const m of tree.matchAll(/(?:clickable|button|link)\s+"([^"]+)"/g)) clicks.push(m[1].trim())

const after = k => { const i = text.indexOf(k); return i < 0 ? '' : text.slice(i + k.length) }
const firstWon = s => { const m = s.match(/([\d,]+)\s*원/); return m ? num(m[1]) : 0 }

// 진행 상태: 상품 영역에 적힌 상태 표기를 그대로 읽는다
let status = ''
{
  const st = /(?:결제|배송|구매|입금|반품|교환|환불|주문)\s?[가-힣]{0,4}(?:완료|대기|준비중|준비 중|확정|요청|중)/g
  let seg = text
  const a = text.indexOf('주문 상품')
  const b = text.indexOf('결제 정보')
  if (a >= 0 && b > a) seg = text.slice(a + 5, b)
  for (const m of seg.match(st) || []) {
    if (clicks.some(c => c === m)) continue
    status = m.trim(); break
  }
  if (!status) { const m = text.match(st); if (m) status = m[0].trim() }
}

// 결제 금액
let paid = 0
for (const k of ['결제 금액', '총 결제 금액', '최종 결제 금액']) {
  const seg = after(k)
  if (seg) { paid = firstWon(seg.slice(0, 80)); if (paid) break }
}

// 적립금(포인트) 사용
let points = 0
for (const k of ['적립금 사용', '포인트 사용', '마일리지 사용', '무신사머니 사용', '적립금']) {
  const i = text.indexOf(k)
  if (i < 0) continue
  const m = text.slice(i + k.length, i + k.length + 40).match(/-?\s*([\d,]+)\s*원/)
  if (m) { points = num(m[1]); break }
}

// 결제 수단
let card = ''
{
  let seg = ''
  for (const k of ['결제 수단', '결제수단']) { seg = after(k); if (seg) break }
  seg = seg.split(/이번 주문으로|받은 총 혜택|주문자 정보|배송 정보/)[0] || ''
  for (const c of clicks) if (c.length >= 6 && seg.indexOf(c) > 0) seg = seg.split(c).join(' ')
  seg = seg.split(/최대 \d|첫 결제|결제 혜택|적립 \+/)[0]
  seg = seg.replace(/\s+/g, ' ').trim()
  const parts = seg.split(' ').filter(Boolean)
  const out = []
  for (const p of parts) if (out[out.length - 1] !== p) out.push(p)
  card = out.join(' ').replace(/[·,]$/, '').trim().slice(0, 40)
}

// 적립 합계 (후기 적립 제외, 하위 소계 중복 제거)
let reward = 0
{
  const s = text.indexOf('받은 혜택')
  const e = text.indexOf('받은 총 혜택')
  const seg = s >= 0 ? text.slice(s, e > s ? e : s + 600) : text
  const items = []
  for (const m of seg.matchAll(/([^\s][^원]{0,25}?적립)\s*(?:최대\s*)?([\d,]+)\s*원/g)) {
    const name = m[1]
    if (/후기|리뷰|스냅/.test(name)) continue
    items.push({ name, amt: num(m[2]) })
  }
  const skip = new Set()
  for (let i = 0; i < items.length; i++) {
    if (skip.has(i)) continue
    for (let k = 2; k <= 4; k++) {
      let sum = 0, ok = true
      for (let j = i + 1; j <= i + k; j++) { if (!items[j]) { ok = false; break } sum += items[j].amt }
      if (ok && sum === items[i].amt && items[i].amt > 0) {
        for (let j = i + 1; j <= i + k; j++) skip.add(j)
        break
      }
    }
  }
  items.forEach((it, i) => { if (!skip.has(i)) reward += it.amt })
}

return { source_order_no: no, status, paid, points_used: points || 0, reward: reward || 0, card }
