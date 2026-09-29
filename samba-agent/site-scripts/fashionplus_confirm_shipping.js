// [미실측 — 배송지 저장 금지 조건이라 돌려 보지 않았다] 패션플러스 배송지 확정: set_shipping 이 채우고 하네스가 전화까지 넣은
// '새 주소 입력' 폼의 '등록하기'를 눌러 주소록에 등록·선택하고, 주문서 배송지를 되읽어 이름·주소를 돌려준다.
// 기본 배송지로 설정은 켜지 않는다(꺼져 있어야 누른다). 등록 뒤 '확인' 안내가 뜨면 누른다
// 탭: args.tab > 이 레인의 패션플러스 주문서 탭 하나 · args: name, address, profile, tab · 반환 {ok,name,address,zip,order_tab,note}
const OF = /fashionplus\.co\.kr\/order\/\d+(?:[?#]|$)/
const lines = async q => (await page.get(q ? { selector: q } : {})).tree.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const text = async () => ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const fail = (note, x) => ({ ok: false, note, ...(x || {}) })
const sq = s => String(s || '').replace(/\s+/g, '')
const name = String(args.name || '').trim(), addr = String(args.address || '').trim()
const cand = (await tabs.list()).filter(t => OF.test(t.url || '') && (!args.tab || t.id === args.tab))
if (cand.length !== 1) return fail(cand.length ? `order form ambiguous: ${cand.length} tabs` : 'no order tab')
const tab = cand[0].id
await tabs.switch(tab)
const big = async () => (await lines()).filter(l => /^\[\d{6,}\]/.test(l))
const fr = await big()
const k = fr.findIndex(l => /link "우편번호 찾기"/.test(l))
if (k < 3) return fail('새 주소 입력 폼이 열려 있지 않다', { order_tab: tab })
const valOf = l => ((l || '').match(/value="([^"]*)"/) || [])[1] || ''
// 칸을 채우면 칸 사이에 '지우기' 버튼이 끼어든다(B05369 실측) — 입력칸만 세서 고른다
const [nameL, phoneL, zipL] = fr.slice(0, k).filter(l => /textbox/.test(l)).slice(-3)
const roadL = fr.slice(k + 1).find(l => /textbox/.test(l))
if (valOf(nameL) !== name) return fail('폼 이름이 다르다', { order_tab: tab })
if (!valOf(zipL) || !valOf(roadL)) return fail('폼 주소가 비었다', { order_tab: tab })
if (!/value="[^"]+"/.test(phoneL || '')) return fail('전화 칸이 비었다', { order_tab: tab })
const def = fr.findIndex(l => /clickable "기본 배송지로 설정"/.test(l))
if (def > 0 && /value="on"/.test(fr[def - 1])) { await page.click(parseInt(fr[def].slice(1))); await sleep(300) }
const reg = fr.find(l => /button "등록하기"/.test(l))
if (!reg) return fail('등록하기 버튼 없음', { order_tab: tab })
await page.click(parseInt(reg.slice(1)))
// 등록 뒤 안내(확인)가 뜨면 누르고, 창이 닫히길 기다린다
for (let i = 0; i < 20; i++) {
  await sleep(400)
  const ok = (await lines()).find(l => /button "확인"$/.test(l) && !/^\[\d{6,}\]/.test(l))
  if (ok) { try { await page.click(parseInt(ok.slice(1))) } catch (e) {} }
  if (!(await big()).some(l => /button "등록하기"/.test(l))) break
}
// 창이 목록으로 돌아가 있으면 새 항목을 골라야 할 수 있다 — 여기서는 되읽기만 하고, 다르면 실패로 넘긴다(select_shipping 이 고른다)
const t = await text()
const m = t.match(/배송지 정보 (\S+?)배송지 변경 (\d{5}) (.+?) (?:0\d{1,2}-?\d{3,4}-?\d{4}|배송메모)/)
if (!m) return fail('주문서 배송지 되읽기 실패', { order_tab: tab })
const nums = addr.replace(/^\d{5}\s*/, '').match(/\d+(-\d+)?/g) || []
const same = m[1] === name && nums.every(n => sq(m[3]).includes(n))
return { ok: same, name: m[1], zip: m[2], address: m[3], order_tab: tab, note: same ? null : '등록 뒤 주문서 배송지가 넣은 값과 다르다' }
