// 29CM 정가(할인 전 가격) — 직배/까대기 판정용(정가 ≤ 고객 결제액 → 까대기). 2026-09-26 재작성: 이 스크립트가 연 탭만 읽고 닫는다.
// 상품 페이지 '169,000원 11% 150,580원' 의 앞 값이 정가, 뒤 값이 판매가. 할인이 없으면 판매가가 곧 정가.
// '나의 구매 가능 가격'·'무신사 삼성카드 결제 시' 가격은 정가가 아니다. args: sku(상품 URL·상품번호), profile
// 반환 {normal_price, sale_price, note}
const num = s => parseInt(String(s).replace(/[^\d]/g, ''), 10) || 0
const sku = String(args.sku || '')
const pno = (sku.match(/(?:catalog|products)\/(\d+)/) || [])[1] || (/^\d{5,}$/.test(sku.trim()) ? sku.trim() : null)
if (!pno) return { normal_price: null, sale_price: null, note: '상품번호를 알 수 없다' }
const tid = (String(await tabs.open({ ...(args.profile ? { profile: args.profile } : {}), url: 'https://www.29cm.co.kr/products/' + pno })).match(/tab (\S+)/) || [])[1]
if (tid) await tabs.switch(tid)
await page.waitFor(/나의 구매 가능 가격|바로 구매하기|판매 ?종료/, 10000).catch(() => {})
let tx = ''
for (let i = 0; i < 8; i++) {
  tx = ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
  if (/찜하기.{0,120}?\d[\d,]*원/.test(tx)) break
  await sleep(250)
}
if (tid) await tabs.close(tid).catch(() => {})
// 가격 칸은 '찜하기' 뒤 첫 가격 묶음이다(리뷰·배너의 금액을 잡지 않게)
const area = (tx.split('찜하기').slice(1).join(' ') || tx).slice(0, 400)
const d = area.match(/(\d[\d,]*)원 (\d{1,2})% (\d[\d,]*)원/)
if (d) return { normal_price: num(d[1]), sale_price: num(d[3]), note: null }
const one = area.match(/(\d[\d,]{3,})원/)
if (one) return { normal_price: num(one[1]), sale_price: num(one[1]), note: '할인 없음 — 판매가를 정가로' }
return { normal_price: null, sale_price: null, note: '가격을 못 읽음' }
