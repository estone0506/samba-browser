// 삼바웨이브 주문관리에서 상품주문번호의 행을 찾아 "업데이트"(소싱처 가격·재고 갱신 → 마켓 판매가 수정)를 누르고 결과 문구를 돌려준다
// SAMBA 주문 한 건의 '업데이트' 누르고 결과 문구 읽기. args.orderNo
const T = async () => ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
let sw = (await tabs.list()).find(t => /samba-wave\.vercel\.app\/samba\/orders/.test(t.url || ''))
if (!sw) { await tabs.open({ url: 'https://samba-wave.vercel.app/samba/orders' }); await page.waitFor(/올해/, 15000); await page.click(await page.idOf('올해')); await sleep(1500) }
else await tabs.switch(sw.id)
const ts = await page.idOf('상품명 고객명 상품ID 주문번호 소싱주문번호 송장번호')
await page.select(ts, '주문번호'); await sleep(300)
await page.type(ts + 1, args.orderNo, true)
{ const g = (await page.get({ interactive: true })).tree.match(/^\[(\d+)\] button "검색"/m); if (g) await page.click(+g[1]) }
let tx = ''
for (let i = 0; i < 20; i++) { await sleep(700); tx = await T(); if (tx.includes('상품주문번호 ' + args.orderNo) || tx.includes(args.orderNo)) break }
if (!tx.includes(args.orderNo)) return JSON.stringify({ orderNo: args.orderNo, result: '행 없음' })
const L = (await page.get({ interactive: true })).tree.split('\n').filter(l => /button "업데이트"/.test(l))
if (L.length !== 1) return JSON.stringify({ orderNo: args.orderNo, result: `업데이트 버튼 ${L.length}개 — 누르지 않음` })
await page.click(+L[0].match(/^\[(\d+)\]/)[1])
let msg = null
for (let i = 0; i < 20 && !msg; i++) { await sleep(700); const m = (await T()).match(/\[(\d{2}:\d{2}:\d{2})\]\s*([^[]{0,80}?)(?= 다나와| 쿠팡| 네이버| 가격변경이력|$)/); if (m) msg = m[1] + ' ' + m[2].trim() }
return JSON.stringify({ orderNo: args.orderNo, result: msg || '결과 문구 없음' })
