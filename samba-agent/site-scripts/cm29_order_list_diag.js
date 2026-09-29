
// 진단용: 29CM 주문내역 첫 화면 글자(읽기만)
const o = await tabs.open({ ...(args.profile ? { profile: args.profile } : {}), url: 'https://www.29cm.co.kr/order/my-order/list' })
const tid = (String(o).match(/tab (\S+)/) || [])[1]
if (tid) await tabs.switch(tid)
await sleep(5000)
const t = ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
if (tid) await tabs.close(tid)
return t.slice(0, 1800)
