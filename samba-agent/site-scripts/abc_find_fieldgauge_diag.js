
const o = await tabs.open({ profile: args.profile, url: 'https://abcmart.a-rt.com/mypage/claim/claim-order-main' })
const tid = (String(o).match(/tab (\S+)/) || [])[1]
if (tid) await tabs.switch(tid)
await page.waitFor(/주문번호|로그인/, 10000).catch(() => {})
await sleep(2000)
let out = ''
for (let pg = 1; pg <= 4; pg++) {
  const t = ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
  const hits = t.match(/주문번호 \d+ 주문일시 [^주]+ 총 결제금액 [\d,]+ 원 [^주]*?필드게이지[^주]*?(?=주문번호|꼭 읽어)/g) || []
  out += hits.join(' || ')
  const nx = await page.idOf(String(pg + 1), 0)
  if (nx < 0) break
  await page.click(nx); await sleep(2000)
}
if (tid) await tabs.close(tid)
return out || 'none'
