const norm = s => (s || '').replace(/[\s()\-,.]/g, '')
const val = t => { const m = /value="([^"]*)"/.exec(t || ''); return m ? m[1] : '' }
const fld = async n => val((await page.get({ selector: 'input[name=' + n + ']' })).tree)

const wantName = (args.name || '').trim()
const wantAddr = norm(args.address || '')
const wantDet = norm(args.address_detail || '')

// 1) 주소록 팝업 열기 (이미 열려 있으면 그대로)
let tree = (await page.get({ selector: 'label' })).tree
if (!/배송지 목록/.test(tree) && !/\d{2,4}-\d{3,4}-\d{4}/.test(tree)) {
  for (const t of ['배송 주소록에서 선택', '주소록에서 선택', '배송지 변경', '주소록']) {
    try { await page.clickText(t); break } catch (e) { }
  }
  try { await page.waitFor('배송지 목록', 8000) } catch (e) { }
  tree = (await page.get({ selector: 'label' })).tree
}

// 2) 목록 라벨 파싱 후 이름·주소로 점수 매겨 선택
const rows = []
for (const m of tree.matchAll(/\[(\d+)\] label "([^"]*)"/g)) {
  const txt = m[2]
  if (!/\d{2,4}-\d{3,4}-\d{4}/.test(txt)) continue
  const n = norm(txt)
  let sc = 0
  if (wantName && txt.includes(wantName)) sc += 2
  if (wantAddr && n.includes(wantAddr)) sc += 3
  if (wantDet && n.includes(wantDet)) sc += 3
  rows.push({ id: +m[1], txt, sc })
}
rows.sort((a, b) => b.sc - a.sc)
const best = rows[0]
if (!best || best.sc < 5) {
  return { ok: false, reason: '주소록에 일치 배송지 없음', candidates: rows.map(r => r.txt) }
}

await page.click(best.id)
await sleep(200)
for (const t of ['선택하기', '선택', '적용']) {
  try { await page.clickText(t); break } catch (e) { }
}
await sleep(800)

// 3) 주문서에 반영된 값 되읽기
let name = await fld('ReceiveName')
let a1 = await fld('ReceiveAddr1')
let a2 = await fld('ReceiveAddr2')
if (!name && !a1) {
  await sleep(1200)
  name = await fld('ReceiveName'); a1 = await fld('ReceiveAddr1'); a2 = await fld('ReceiveAddr2')
}
const okName = !wantName || name.includes(wantName) || wantName.includes(name)
const okAddr = !wantAddr || norm(a1 + a2).includes(wantAddr)
return {
  ok: !!(okName && okAddr && (a1 || a2)),
  name: name,
  address: a1,
  address_detail: a2,
  address_full: (a1 + ' ' + a2).trim(),
  selected: best.txt
}