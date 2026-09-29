// 슈마커 로그인 여부 — 로그인해도 상단에 '로그인' 링크가 남아 앱의 공통 판정이 틀린다(실기 2026-09-26).
// 회원 전용 페이지(찜목록)에서 "MY PAGE ○○님" 이 보이면 로그인, 로그인 입력칸이 보이면 비로그인. 반환 {signed_in, note}
const opened = await tabs.open({ ...(args.profile ? { profile: args.profile } : {}), url: 'https://www.shoemarker.co.kr/ASP/Mypage/MyPickList.asp' })
const tabId = (String(opened).match(/tab (\S+)/) || [])[1] || null
await page.waitFor(/MY PAGE|UserID|로그인/, 8000).catch(() => {})
const tr = (await page.get({ interactive: true })).tree
const tx = ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const named = /MY PAGE\s*[가-힣A-Za-z]{1,10}\s*님/.test(tx)
const form = /name=UserID/.test(tr) && /name=NPwd/.test(tr)
if (tabId) { try { await tabs.close(tabId) } catch (e) {} }
return { signed_in: named && !form, note: named ? null : (form ? 'login form shown' : 'no member name') }
