// 롯데온 상품 정가(세일 전 정상가) — 포이즌 외 마켓의 직배/까대기 판정에 쓴다.
// 상품 페이지 '가격 정보'의 "판매가 35,100원 할인전 가격 39,000" 에서 할인전 가격을 정가로, 없으면 판매가를 정가로 본다.
// 반환 {normal_price, sale_price, note}
const num = s => Number(String(s || '').replace(/[^\d]/g, '') || 0)
const raw = String(args.sku || '').trim()
if (!raw) return { normal_price: null, note: 'sku 없음' }
const url = /^https?:/.test(raw) ? raw : 'https://www.lotteon.com/p/product/' + raw
const opened = await tabs.open({ ...(args.profile ? { profile: args.profile } : {}), url })
const tabId = (String(opened).match(/tab (\S+)/) || [])[1] || null
await page.waitFor(/판매가/, 10000).catch(() => {})
const tx = ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const i = tx.indexOf('가격 정보')
const seg = i >= 0 ? tx.slice(i, i + 300) : tx
const sale = num((seg.match(/판매가\s*([\d,]+)\s*원/) || [])[1])
const before = num((seg.match(/할인전\s*가격\s*([\d,]+)/) || [])[1])
if (tabId) { try { await tabs.close(tabId) } catch (e) {} }
const normal = before || sale
return { normal_price: normal || null, sale_price: sale || null, note: normal ? null : '가격 정보 못 읽음' }
