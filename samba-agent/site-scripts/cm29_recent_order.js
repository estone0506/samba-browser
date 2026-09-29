// 29CM 결제 확인 폴백(2026-09-27) — 완료 화면을 못 잡았을 때 주문내역에서 방금 생긴 '결제완료' 주문을 찾는다(읽기만).
// 목록 링크: '주문상세'·'결제완료 …'·'<상품명> [옵션]<가격> / 수량 N개' 가 같은 상세(detail/<id>)를 가리킨다.
// 상품명 단어가 모두 들어 있고 옵션이 맞는 결제완료 주문만 상세를 열어 '주문번호 ORD…'·'결제일시'를 읽는다.
// 결제일시가 withinMin(기본 10분) 안인 것이 정확히 하나일 때만 order_no 를 준다 — 0건·여러 건이면 null(사람에게).
// args: profile, name, option, withinMin  반환 {order_no, paid, method, at, note}
const text = t => (t.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const num = s => s ? parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0 : 0
const norm = s => String(s || '').toLowerCase().replace(/[\s\-_/:().,[\]·+]/g, '')
const out = (note, x) => ({ order_no: null, paid: 0, method: '', at: '', note, ...(x || {}) })
const name = String(args.name || '').trim(), option = String(args.option || '').trim()
if (!args.profile) return out('profile 없음')
if (!name) return out('name 없음 — 어느 주문인지 모른다')
const within = Number(args.withinMin) > 0 ? Number(args.withinMin) : 10
const words = name.split(/\s+/).map(norm).filter(w => w.length >= 2)
if (!words.length) return out('상품명 단어 없음')
const prof = { profile: args.profile }
const opened = []
const open = async url => { const id = (String(await tabs.open({ ...prof, url })).match(/tab (\S+)/) || [])[1]; if (id) { opened.push(id); await tabs.switch(id) } return id }
const closeAll = async () => { for (const id of opened) await tabs.close(id).catch(() => {}) }
try {
  await open('https://www.29cm.co.kr/order/my-order/list')
  await page.waitFor(/주문상세/, 12000).catch(() => {})
  const lt = (await page.get({ selector: 'a[href*="my-order/detail"]' })).tree
  const full = (await page.get({})).tree
  if (!/\] button "로그아웃"/.test(full)) return out('로그인 안 됨')
  // 상세 id 별로 상태·상품 줄을 모은다
  const byId = new Map()
  for (const m of lt.matchAll(/\] link "([^"]*)" href=\S*\/my-order\/detail\/(\d+)/g)) {
    const [, label, id] = m
    const e = byId.get(id) || { status: '', items: [] }
    if (/^(입금대기|결제완료|상품준비중|배송시작|배송중|배송완료|구매확정|취소|반품|교환)/.test(label)) e.status = e.status || label.split(' ')[0]
    else if (/수량 \d+개/.test(label)) e.items.push(label)
    byId.set(id, e)
  }
  if (!byId.size) return out('주문내역에서 주문상세 링크를 못 읽음')
  // 옵션: 목록의 '[라벨]값' 에서 값만. 주문 옵션과 한쪽이 다른 쪽을 품으면 같은 옵션
  const optOf = s => ((s.match(/\]([^\]]*?)\s*[\d,]+원 \/ 수량/) || [])[1] || '').trim()
  const optOk = s => { if (!option) return true; const a = norm(optOf(s)), b = norm(option); return !!a && (a.includes(b) || b.includes(a)) }
  const nameOk = s => { const n = norm(s.replace(/\s*\[[^\]]*\][^\]]*$/, '')); return words.every(w => n.includes(w)) }
  const cands = [...byId].filter(([, e]) => e.status === '결제완료' && e.items.length === 1 && nameOk(e.items[0]) && optOk(e.items[0])).slice(0, 5)
  if (!cands.length) return out('이름·옵션이 맞는 결제완료 주문 없음(' + byId.size + '건 확인)')
  const now = Date.now(), hits = []
  for (const [id] of cands) {
    await open('https://www.29cm.co.kr/order/my-order/detail/' + id)
    await page.waitFor(/결제일시/, 10000).catch(() => {})
    const d = text((await page.get({})).tree)
    const no = (d.match(/주문번호 (ORD[\d-]+)/) || [])[1]
    const dt = d.match(/결제일시 (\d{4})\.(\d\d)\.(\d\d) (\d\d):(\d\d)/)
    if (!no || !dt) continue
    const at = dt[1] + '-' + dt[2] + '-' + dt[3] + ' ' + dt[4] + ':' + dt[5]
    const ms = Date.parse(dt[1] + '-' + dt[2] + '-' + dt[3] + 'T' + dt[4] + ':' + dt[5] + ':00+09:00')
    if (!(Math.abs(now - ms) <= within * 60000)) continue
    const pay = d.slice(d.indexOf('결제정보'), d.indexOf('배송지정보') > 0 ? d.indexOf('배송지정보') : undefined)
    const pm = pay.match(/결제금액 ([\d,]+)원 (\S+(?: \S+)?) [\d,]+원/)
    hits.push({ order_no: no, paid: num(pm && pm[1]), method: (pm && pm[2]) || '', at })
  }
  if (hits.length !== 1) return out(hits.length ? '맞는 주문 ' + hits.length + '건 — 하나로 못 정함' : within + '분 안 결제완료 주문 없음(' + cands.length + '건 확인)', hits.length ? { hits: hits.map(h => h.order_no) } : null)
  return { ...hits[0], note: null }
} finally {
  await closeAll()
}
