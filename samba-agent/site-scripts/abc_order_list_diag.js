
// 진단용: ABC 주문/배송 조회 첫 화면 글자를 읽는다(읽기만)
const o = await tabs.open({ ...(args.profile ? { profile: args.profile } : {}), url: 'https://abcmart.a-rt.com/mypage/claim/claim-order-main' })
const tid = (String(o).match(/tab (\S+)/) || [])[1]
if (tid) await tabs.switch(tid)
await page.waitFor(/주문번호|로그인/, 10000).catch(() => {})
await sleep(2000)
const t = ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
if (tid) await tabs.close(tid)
const i = t.indexOf('주문번호')
return JSON.stringify({ opened: String(o).slice(0, 120), text: t.slice(Math.max(0, i - 200), i + 2200) })
