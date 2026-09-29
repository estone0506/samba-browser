
// 진단용: 29CM 주문상세 글자(읽기만)
const o = await tabs.open({ profile: args.profile, url: 'https://www.29cm.co.kr/order/my-order/detail/' + args.id })
const tid = (String(o).match(/tab (\S+)/) || [])[1]
if (tid) await tabs.switch(tid)
await sleep(5000)
const t = ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
if (tid) await tabs.close(tid)
const i = t.indexOf('주문번호')
return t.slice(Math.max(0, i - 50), i + 1600)
