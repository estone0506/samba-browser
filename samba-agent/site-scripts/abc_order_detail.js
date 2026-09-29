// ABC마트·그랜드스테이지 주문 상세 읽기 — 주문을 바꾸거나 취소하지 않는다(읽기만).
// 2026-09-26 재작성: 스크립트가 연 탭(profile 프로필)에서 읽고 닫는다, 고정 sleep 대신 waitFor.
// args: source_order_no(또는 orderNo), profile, site('GrandStage'면 그랜드스테이지)
// 반환 {source_order_no, status, paid(현금 결제액 = 총 결제금액 − 포인트), points_used, reward(후기 제외), card, note}
const no = String(args.source_order_no || args.orderNo || '').trim()
if (!/^\d{8,}$/.test(no)) return { source_order_no: no, status: '', paid: 0, points_used: 0, reward: 0, card: '', note: 'no source_order_no' }
const num = s => (s == null ? 0 : parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0)
const host = /grand/i.test(String(args.site || '')) ? 'grandstage.a-rt.com' : 'abcmart.a-rt.com'
const url = `https://${host}/mypage/order/read-order-detail?orderNo=${no}`
const tid = (String(await tabs.open(args.profile ? { url, profile: args.profile } : { url })).match(/tab (\S+)/) || [])[1]
if (!tid) return { source_order_no: no, status: '', paid: 0, points_used: 0, reward: 0, card: '', note: 'tab open failed' }
await tabs.switch(tid)
await page.waitFor(/결제 정보|주문내역이 없|로그인/, 8000).catch(() => {})
const t = ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
await tabs.close(tid).catch(() => {})
if (!t.includes(no)) return { source_order_no: null, status: '', paid: 0, points_used: 0, reward: 0, card: '', note: /\bLOGOUT\b/.test(t) ? '주문번호를 찾지 못함(다른 계정 주문?)' : '로그인 안 됨' }

// 상태 — 상품 줄의 '온라인 결제완료' 등
const CONF = '구매\\s*확' + '정' // 상태 글자(버튼 아님)
const st = t.match(new RegExp(`(입금대기|결제완료|상품준비중|배송준비중|배송중|배송완료|수령완료|픽업준비완료|${CONF}|취소완료|취소접수|교환접수|반품접수|반품완료)`))
const status = st ? st[1] : ''

// 결제 정보: '총 결제금액 84,500원 … 상시할인 4,500원 네이버페이 84,500 원 꼭 읽어'
const k = t.search(/결제 정보 주문금액/)
const e = k >= 0 ? t.indexOf('꼭 읽어', k) : -1
const pay = k >= 0 ? t.slice(k, e > k ? e : k + 1500) : ''
const total = num((pay.match(/총 결제금액 ([\d,]+) ?원/) || [])[1])
// 결제 수단 줄(할인 줄 뒤): 수단 이름 + 금액
// '결제변경 이력'(취소·환불 줄)은 빼고 읽는다
const tail = pay.slice(Math.max(0, pay.search(/상시할인 [\d,]+ ?원/))).split('결제변경 이력')[0]
const re = /(네이버페이|카카오페이|TOSS|토스페이|페이코|PAYCO|신용카드|체크카드|[가-힣A-Z]{2,6}카드|실시간계좌이체|무통장입금|휴대폰결제|포인트|기프트카드)\s*([\d,]+)\s*(원|P)/g
let m, points = 0, cash = 0
const methods = []
while ((m = re.exec(tail))) {
  if (/포인트|기프트카드/.test(m[1])) points += num(m[2])
  else { cash += num(m[2]); methods.push(m[1]) }
}
// 수단 줄을 못 읽으면 총 결제금액 − 포인트(총 결제금액은 포인트를 포함한다 — 실기 2026-09-25 포인트 이중 계산)
if (!points) points = num((pay.match(/포인트\s*(?:사용|결제)?\s*([\d,]+)\s*P/) || [])[1])
const paid = methods.length ? cash : Math.max(0, total - points)

// 적립(후기 적립 제외) — a-rt 는 구매확정 뒤 지급이라 보통 상세에 없다(0)
let reward = 0
const rre = /(구매\s*적립|적립\s*예정|적립\s*포인트)[^0-9]{0,12}([\d,]+)\s*P/g
while ((m = rre.exec(t))) if (!/후기|리뷰/.test(t.slice(Math.max(0, m.index - 12), m.index))) reward += num(m[2])

let card = methods.join(' - ')
const co = (tail.match(/(현대|롯데|국민|KB|신한|삼성|하나|BC|비씨|우리|농협|NH|씨티)\s*카드/) || [])[1]
if (co && !card.includes(co)) card = [card, co + '카드'].filter(Boolean).join(' - ')
if (paid === 0 && points > 0) card = '포인트전액'
else if (!card && points > 0) card = '포인트'

return { source_order_no: no, status, paid, points_used: points, reward, card, total, note: total ? null : '총 결제금액 못 읽음' }
