// 무신사페이 등록 기본 카드 견적(2026-09-26 재작성): 주문서에서 무신사페이를 골라 등록 카드 목록 맨 앞(결제 카드)과 그때 금액·적립·사용 적립금.
// 결제하기는 누르지 않는다. 주문서 탭은 args.tab, 없으면 레인에 하나뿐인 무신사 주문서(여럿이면 멈춘다 — 197←196 사고).
// 반환 {ok, quotes:[{method:'무신사페이',card,cost,reward,points_used,registered,allowed,available,note}], cards, note}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const OF = /musinsa\.com\/order\/order-form/
const get = async o => { for (let i = 0; i < 6; i++) { try { return (await page.get(o)).tree } catch (e) { await sleep(600) } } return '' }
const ofs = (await tabs.list()).filter(t => OF.test(t.url || ''))
const tab = args.tab ? ofs.find(t => t.id === args.tab) : ofs.length === 1 ? ofs[0] : null
if (!tab) return { ok: false, note: ofs.length ? `order forms ${ofs.length} open — pass args.tab` : 'no order form' }
await tabs.switch(tab.id)
try { await page.waitFor('총 결제 금액', 8000) } catch (e) {}
const radioOf = t => { const l = t.split('\n').find(x => /^\[\d+\] radio "무신사페이/.test(x)); return l ? parseInt(l.slice(1)) : 0 }
const rid = radioOf(await get({ interactive: 1 })) || radioOf(String(await page.find('무신사페이')))
if (!rid) return { ok: false, note: 'no musinsapay radio' }
await page.click(rid)
try { await page.waitFor('무신사페이 결제', 3000) } catch (e) { await sleep(800) }
const tr = await get({ interactive: 1 }), box = tr.match(/textbox "보유 적립금 사용" value="([\d,]+)"/)
const t = nz((await get({})).split('PAGE TEXT:')[1])
const pay = t.slice(t.indexOf('결제 수단'), t.indexOf('결제 금액 상품 금액'))
// 등록 카드 '이름 (705*) 체크카드|신용카드'. '혜택 받기' 광고 카드(무신사 삼성카드 등)는 번호가 없어 안 잡힌다
const cards = [...pay.matchAll(/([가-힣A-Za-z0-9 ]{2,30}?)\s*\((\d{3,4}\*?)\)\s*(신용카드|체크카드)/g)].map(m => nz(m[1].split(/혜택 관리|혜택 받기|추가 할인|적립/).pop()).replace(/^(일시불|할부)\s*/, '')).filter(Boolean)
if (!cards.length) return { ok: false, cards: [], note: 'no registered card' }
const s = t.slice(t.lastIndexOf('결제 금액 상품 금액'))
const cost = num((s.match(/총 결제 금액\s*(?:\d+%\s*)?([\d,]+)\s*원/) || [])[1])
const tot = num((s.match(/총 적립 금액\s*([\d,]+)\s*원/) || [])[1]), rev = num((s.match(/후기 적립\s*최대\s*([\d,]+)\s*원/) || [])[1])
// 사용 적립금은 '보유 적립금 사용' 칸 값만(선할인은 할인이라 넣지 않는다)
const q = { method: '무신사페이', card: cards[0], cost, reward: Math.max(0, tot - rev), points_used: box ? num(box[1]) : 0, registered: true, allowed: true, available: cost > 0, note: '등록 기본 카드(맨 앞) — 결제도 이 카드로 된다' }
return { ok: cost > 0, quotes: [q], cards }
