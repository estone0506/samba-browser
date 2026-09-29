// SAMBA 주문 한 건의 표시 버튼(가격X·재고X) 누르기. args.orderNo, args.label
// 버튼은 토글이다 — 호출자가 태그를 먼저 읽고 없을 때만 부른다. 행이 정확히 하나일 때만 누른다
if (!/^(가격X|재고X)$/.test(String(args.label || ''))) return JSON.stringify({ ok: false, note: '허용 밖 표시: ' + args.label })
const T = async () => ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
let sw = (await tabs.list()).find(t => /samba-wave\.vercel\.app\/samba\/orders/.test(t.url || ''))
if (!sw) { await tabs.open({ url: 'https://samba-wave.vercel.app/samba/orders' }); await page.waitFor(/올해/, 15000); await page.click(await page.idOf('올해')); await sleep(1500) }
else await tabs.switch(sw.id)
const ts = await page.idOf('상품명 고객명 상품ID 주문번호 소싱주문번호 송장번호')
await page.select(ts, '주문번호'); await sleep(300)
await page.type(ts + 1, args.orderNo, true)
{ const g = (await page.get({ interactive: true })).tree.match(/^\[(\d+)\] button "검색"/m); if (g) await page.click(+g[1]) }
let tx = ''
for (let i = 0; i < 20; i++) { await sleep(700); tx = await T(); if (tx.includes(args.orderNo)) break }
if (!tx.includes(args.orderNo)) return JSON.stringify({ ok: false, note: '행 없음' })
const re = args.label === '가격X' ? /^\[(\d+)\] button "가격X"$/ : /^\[(\d+)\] button "재고X"$/
const L = (await page.get({ interactive: true })).tree.split('\n').filter(l => re.test(l))
// 상품주문번호 하나에 행이 여럿일 수 있다(옵션 2개 주문) — 검색 결과 행마다 하나씩 누른다. 행 수와 다르면 멈춘다
const rows = ((await T()).match(new RegExp(args.orderNo, 'g')) || []).length
if (L.length < 1 || L.length > 4) return JSON.stringify({ ok: false, note: `${args.label} 버튼 ${L.length}개 — 누르지 않음` })
for (const l of L) { await page.click(+l.match(/^\[(\d+)\]/)[1]); await sleep(900) }
await sleep(600)
return JSON.stringify({ ok: true, clicked: L.length, rows })
