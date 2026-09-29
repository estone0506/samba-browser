// 29CM 주문 상세(2026-09-26 재작성) — 계정 profile 의 주문배송 목록에서 주문번호(ORD20260925-4056962)의 상세를 열어 결제 값을 읽는다.
// 목록엔 주문번호가 없고 상세 번호(detail/66976857)만 있다 — 주문번호의 날짜와 같은 날 주문의 상세만 차례로 열어 번호를 대조한다
// (예전 판은 profile 없이 기본 세션으로 열고, 못 찾으면 첫 주문을 돌려줬다 — 다른 주문 값을 쓰는 위험).
// reward = '구매확정 (N원)'(구매 적립, 후기 적립 제외). 구매확정 전 표시가 없으면 0 — 기록 단계가 견적 적립을 쓴다.
// card = '결제수단 - 카드사'. 카드사가 상세에 없고 카드 결제(무신사페이·카드)면 영수증 창에서 카드 종류를 읽는다.
// args: source_order_no, profile  반환 {source_order_no, status, paid, points_used, points_box, reward, card, note}
const text = t => (t.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const num = s => s ? parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0 : 0
const no = String(args.source_order_no || '').trim()
const empty = note => ({ source_order_no: no || null, status: '', paid: 0, points_used: 0, reward: 0, card: '', note })
if (!no) return empty('source_order_no 없음 — 어느 주문인지 모른다(첫 주문으로 대신하지 않는다)')
const prof = args.profile ? { profile: args.profile } : {}
const open = async url => { const id = (String(await tabs.open({ ...prof, url })).match(/tab (\S+)/) || [])[1]; if (id) await tabs.switch(id); return id }
const lid = await open('https://www.29cm.co.kr/order/my-order/list')
await page.waitFor(/주문상세/, 10000).catch(() => {})
const lt = (await page.get({})).tree
if (!/\] button "로그아웃"/.test(lt)) { await tabs.close(lid).catch(() => {}); return empty('로그인 안 됨') }
// i 번째 '주문상세' 링크 ↔ 목록 글자의 i 번째 '<날짜> 주문상세'
const ids = [...lt.matchAll(/\] link "주문상세" href=\S*\/detail\/(\d+)/g)].map(m => m[1])
const dates = [...text(lt).matchAll(/(\d{4})\. (\d{1,2})\. (\d{1,2}) 주문상세/g)].map(m => m[1] + m[2].padStart(2, '0') + m[3].padStart(2, '0'))
await tabs.close(lid).catch(() => {})
const day = (no.match(/(\d{8})/) || [])[1]
const cand = ids.filter((id, i) => !day || dates.length !== ids.length || dates[i] === day).slice(0, 10)
let d = '', did = null
for (const id of cand) {
  did = await open('https://www.29cm.co.kr/order/my-order/detail/' + id)
  await page.waitFor(/결제금액/, 8000).catch(() => {})
  const tx = text((await page.get({})).tree)
  if ((tx.match(/주문번호 (\S+)/) || [])[1] === no) { d = tx; break }
  await tabs.close(did).catch(() => {}); did = null
}
if (!d) return empty('주문번호 ' + no + ' 를 목록(' + cand.length + '건 확인)에서 못 찾음')
const pay = d.slice(d.indexOf('결제정보'), d.indexOf('배송지정보') > 0 ? d.indexOf('배송지정보') : undefined)
const paid = num((pay.match(/결제금액 ([\d,]+)원/) || [])[1])
const method = (pay.match(/결제금액 [\d,]+원 (\S+(?: \S+)?) [\d,]+원/) || [])[1] || ''
// 적립금: 보유 적립금 사용과 선할인이 따로 보이면 보유분만 points_box 로(선할인은 결제액을 이미 깎았다)
const box = pay.match(/보유 적립금 사용 ([\d,]+)원/)
const points_used = num((pay.match(/적립금 사용 ([\d,]+)원/) || [])[1])
const reward = num((d.match(/구매확정 \(([\d,]+)원\)/) || [])[1])
const status = (d.match(/장바구니 담기 (\S+)/) || [])[1] || ''
// '무신사 삼성카드'(제휴카드 할인 줄)는 결제 카드가 아니다
let issuer = ([...pay.matchAll(/(무신사 )?([가-힣]{2,5}카드)(?!\s*할인)/g)].find(m => !m[1] && m[2] !== '제휴카드') || [])[2] || ''
if (!issuer && !/머니/.test(method)) {
  const rb = ((await page.get({ query: '영수증' })).tree.match(/\[(\d+)\] button "영수증[^"]*"/) || [])[1]
  if (rb) {
    const before = new Set((await tabs.list()).map(x => x.id))
    await page.click(+rb)
    let pop = null
    for (let i = 0; i < 20 && !pop; i++) { await sleep(250); pop = (await tabs.list()).find(x => !before.has(x.id)) }
    if (pop) {
      await tabs.switch(pop.id)
      await page.waitFor(/카드/, 6000).catch(() => {})
      const pt = text((await page.get({})).tree)
      issuer = (pt.match(/카드\s?종류\s*([가-힣A-Za-z]{2,8}카드)/) || pt.match(/([가-힣]{2,5}카드)/) || [])[1] || ''
      await tabs.close(pop.id).catch(() => {})
    }
  }
}
if (did) await tabs.close(did).catch(() => {})
return {
  source_order_no: no, status, paid, points_used, ...(box ? { points_box: num(box[1]) } : {}), reward,
  card: [method, issuer].filter(Boolean).join(' - '), note: paid ? null : '결제금액 못 읽음'
}
