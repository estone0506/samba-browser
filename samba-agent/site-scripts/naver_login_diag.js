
// 진단용: 네이버페이 주문내역을 열어 로그인 화면으로 넘어가는지만 본다(입력 없음)
const o = await tabs.open({ ...(args.profile ? { profile: args.profile } : {}), url: 'https://order.pay.naver.com/home' })
const tid = (String(o).match(/tab (\S+)/) || [])[1]
await sleep(4000)
const l = (await tabs.list()).find(t => t.id === tid)
if (tid) await tabs.close(tid)
return String(o).slice(0, 90) + ' => ' + (l && l.url || '').slice(0, 80)
