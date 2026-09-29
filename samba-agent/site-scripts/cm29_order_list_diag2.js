
// 진단용: 29CM 주문내역의 주문상세 링크 주소(읽기만)
const o = await tabs.open({ profile: args.profile, url: 'https://www.29cm.co.kr/order/my-order/list' })
const tid = (String(o).match(/tab (\S+)/) || [])[1]
if (tid) await tabs.switch(tid)
await sleep(5000)
const t = (await page.get({ selector: 'a[href*="order"]' })).tree
if (tid) await tabs.close(tid)
return t.split('\n').filter(l => /주문상세|detail/i.test(l)).slice(0, 4).join('\n')
