// SSG 결제수단 견적(2026-09-27, 로그인 실측 반영): 열린 SSG 주문서(pay.ssg.com/order/ordPage.ssg)에서 결제 가능한 줄을 읽는다. 결제하기는 누르지 않는다.
// 실측 구조: 결제수단 라디오 'SSGPAY 카드'(등록 카드 라디오 name=_cpay_ssgpay_card, '현대카드(850*) 선택하기') · 'SSGPAY 계좌' · '일반결제'.
// 'SSG MONEY 충전결제' 체크박스를 켜면 연결 계좌에서 만원 단위로 충전해 SSG MONEY 로 결제하고 1.5% 적립('적립 예정 SSG MONEY N원').
// 카드 선택은 결제 예정금액을 바꾸지 않았다(청구할인은 하네스가 카드 이름으로 계산). 줄마다 금액을 다시 읽는다.
// 원가 = cost × 카드 청구할인 − reward + points_used. 끝나면 충전결제를 끄고 처음 카드로 되돌린다.
// 인자 {tab?, profile?, methods?}  반환 {quotes:[{method,card,cost,reward,points_used,registered,allowed,available}], base_cost, note}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const OF = /pay\.ssg\.com\/(order|payment)/
const tree = async o => { for (let i = 0; i < 4; i++) { try { const g = await page.get(o || {}); if (g && g.tree) return g.tree } catch (e) {} await sleep(500) } return '' }
const text = async () => nz((await tree()).split('PAGE TEXT:')[1])
const lines = async () => (await tree({ interactive: true })).split('\n')
const notes = []
const ofs = (await tabs.list()).filter(t => t.kind === 'tab' && OF.test(t.url || ''))
const tab = args.tab ? ofs.find(t => t.id === String(args.tab)) : ofs.length === 1 ? ofs[0] : null
if (!tab) return { quotes: [], base_cost: null, note: ofs.length ? `order forms ${ofs.length} open — pass args.tab` : 'no order form' }
await tabs.switch(tab.id)
try { await page.waitFor('결제 예정금액', 8000) } catch (e) {}

const read = async () => {
  const t = await text()
  const cost = num((t.match(/결제\s*예정\s*금액\s*([\d,]{3,})\s*원/) || [])[1])
  // 적립 예정(충전결제를 켰을 때만 뜬다) — '충전 후 결제하면 … 적립예정' 안내 문구는 세지 않는다
  const reward = num((t.match(/적립\s*예정\s*SSG\s*MONEY\s*([\d,]+)\s*원/i) || [])[1])
  // 사용한 SSG MONEY·신세계포인트(주문서 요약 '포인트 사용')
  const used = num((t.match(/포인트\s*사용\s*-?\s*([\d,]+)\s*원/) || [])[1])
  return { t, cost, reward, used }
}
const clickLine = async re => { const l = (await lines()).find(x => re.test(x)); if (!l) return false; await page.click(parseInt(l.slice(1))); await sleep(1200); return true }
const base = await read()
const quotes = []
const ALLOWED = /^(현대|KB|국민|롯데|신한|농협|NH)/ // 카드사 이름으로 시작해야('우리 국민행복카드'는 우리카드)
// 1) SSGPAY 카드: 등록 카드마다
const cardLines = (await lines()).filter(l => /^\[\d+\] radio ".+선택하기" name=_cpay_ssgpay_card/.test(l))
// 처음 골라져 있던 카드(없으면 null) — 끝나면 되돌린다
const orig = (cardLines.find(l => /value="on"/.test(l)) || '').match(/radio "(.+?)"/)
for (const l of cardLines) {
  const label = (l.match(/radio "(.+?)\s*선택하기"/) || [])[1] || ''
  const card = nz(label.replace(/\(\d{3,4}\*\)/, '').replace(/\s*\(\S*$/, ''))
  if (!ALLOWED.test(card)) { quotes.push({ method: 'SSGPAY', card, cost: base.cost, reward: 0, points_used: base.used, registered: true, allowed: false, available: false }); continue }
  await page.click(parseInt(l.slice(1)))
  await sleep(1000)
  const r = await read()
  quotes.push({ method: 'SSGPAY', card, cost: r.cost, reward: 0, points_used: r.used, registered: true, allowed: true, available: r.cost > 0 })
}
if (!cardLines.length) notes.push('SSGPAY 등록 카드 없음')
// 2) SSG MONEY 충전결제(연결 계좌 필요) — 켜고 읽고 끈다
if (await clickLine(/^\[\d+\] checkbox "SSG MONEY 충전결제" value="off"/)) {
  const r = await read()
  const acct = /충전\s*금액\s*\S*은행|충전\s*금액\s*\S*\(\d/.test(r.t)
  // 적립: 요약의 '적립 예정 SSG MONEY N원'이 안 뜰 때가 있어(실측) 충전결제 칸 안내 'N원 적립예정'으로 보충 — 이 줄은 충전결제를 켠 경우라 해당된다
  const rw = r.reward || num((r.t.match(/충전\s*후\s*결제하면\s*SSG\s*MONEY\s*([\d,]+)\s*원\s*적립\s*예정/i) || [])[1])
  quotes.push({ method: 'SSG MONEY 충전결제', card: null, cost: r.cost, reward: rw, points_used: r.used, registered: acct, allowed: true, available: acct && r.cost > 0 })
  if (!acct) notes.push('충전결제 연결 계좌 없음')
  await clickLine(/^\[\d+\] checkbox "SSG MONEY 충전결제" value="on"/)
} else notes.push('충전결제 칸 없음')
// 카드 라디오 원복: 처음 카드로 다시 누른다. 처음에 아무 카드도 없었으면 라디오는 해제할 수 없어 note 로 알린다
if (orig) { const l = (await lines()).find(x => x.includes('radio "' + orig[1] + '"')); if (l) { await page.click(parseInt(l.slice(1))); await sleep(600) } }
else if (cardLines.length) notes.push('처음엔 카드 미선택 — 마지막 견적 카드가 선택된 채 남음(결제 진입이 카드를 다시 고른다)')
return { quotes, base_cost: base.cost || null, note: notes.join('; ') || null }
