// ABC마트·그랜드스테이지 쿠폰 받기 — 이벤트·쿠폰 페이지 '전체 쿠폰 다운로드'로 이 계정이 받을 수 있는 쿠폰을 먼저 받는다.
// 상품 페이지 '쿠폰 다운받기'는 브라우저에서 반응이 없어(2026-09-28) 쓰지 않는다. 결과 안내에서 받은 쿠폰 이름을 돌려준다.
// args: profile(계정), sku(무시) · 반환 {ok, clicked, issued:[쿠폰명], skipped, note}
const profile = String(args.profile || '').trim()
const site = /grandstage/.test(String(args.sku || args.site || '')) ? 'grandstage' : 'abcmart'
const url = `https://${site}.a-rt.com/promotion/event/main`
const before = new Set(((await tabs.list()) || []).map(t => t.id))
const close = async () => { for (const t of (await tabs.list()) || []) if (!before.has(t.id)) { try { await tabs.close(t.id) } catch (e) {} } }
await tabs.open({ url, profile: profile || undefined }); await sleep(5000)
let g = await page.get({})
let t = (g.tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
if (!/LOGOUT/.test(t.slice(0, 400))) { await close(); return { ok: false, clicked: false, issued: [], note: `로그인 안 됨(${profile})` } }
const m = g.tree.match(/^\[(\d+)\] button "전체 쿠폰 다운로드"/m)
if (!m) { await close(); return { ok: true, clicked: false, issued: [], note: '전체 쿠폰 다운로드 버튼 없음' } }
await page.click(+m[1]); await sleep(4000)
g = await page.get({})
t = (g.tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const i = t.indexOf('쿠폰 다운로드 안내')
const box = i >= 0 ? t.slice(i, i + 600) : ''
const issued = [...box.matchAll(/\[\s*([^\]]+?)\s*\]/g)].map(x => x[1])
const skipped = (box.match(/(\d+)개 쿠폰은 ID당 발급 횟수 초과/) || [])[1] || null
const c = g.tree.match(/^\[(\d+)\] (?:button|clickable|link) "(?:돌아가기|Close)"/m)
if (c) { try { await page.click(+c[1]) } catch (e) {} }
await close()
return { ok: true, clicked: true, issued, skipped: skipped ? +skipped : 0, note: box ? null : '결과 안내 못 읽음' }
