
const card = String(args.card || '').trim();
const easypayMap = [
  ['카카오', 'kakao'], ['토스', 'toss'], ['페이코', 'payco'], ['삼성페이', 'samsungpay'],
  ['네이버', 'naver'], ['SSG', 'ssg'], ['스마일페이', 'smile'], ['W페이', 'wpay'], ['W.페이', 'wpay']
];
let kind = null;
for (const [k, v] of easypayMap) { if (card.includes(k)) { kind = v; break; } }
let methodLabel = card;
let popup_url = null;

if (kind === 'ssg') {
  const id = await page.idOf('SsgPay간편결제', 0);
  if (id !== -1) { await page.click(id); methodLabel = 'SsgPay 간편결제'; }
} else if (kind === 'smile') {
  const id = await page.idOf('SmilePay간편결제', 0);
  if (id !== -1) { await page.click(id); methodLabel = 'SmilePay 간편결제'; }
} else if (kind === 'wpay') {
  const id = await page.idOf('W.페이', 0);
  if (id !== -1) { await page.click(id); methodLabel = 'W.페이'; }
} else if (kind) {
  const genId = await page.idOf('일반결제', 0);
  if (genId !== -1) await page.click(genId);
  await sleep(300);
  const tabId = await page.idOf('간편결제', 0);
  if (tabId !== -1) await page.click(tabId);
  await sleep(500);
  const order = ['kakao', 'toss', 'payco', 'samsungpay', 'naver'];
  const idx = order.indexOf(kind);
  const s = await page.get({ selector: '[name=ordertype1]', interactive: true });
  const ids = [...s.tree.matchAll(/\[(\d+)\] radio/g)].map(m => +m[1]);
  if (idx >= 0 && ids[idx] !== undefined) { await page.click(ids[idx]); methodLabel = card; }
} else if (card) {
  const genId = await page.idOf('일반결제', 0);
  if (genId !== -1) await page.click(genId);
  await sleep(300);
  const creditId = await page.idOf('신용카드', 0);
  if (creditId !== -1) await page.click(creditId);
  await sleep(400);
  const ddId = await page.idOf('카드 선택', 1);
  if (ddId !== -1) {
    await page.click(ddId);
    await sleep(400);
    const s = await page.get({ query: card, interactive: true });
    const m = s.tree.match(new RegExp('\\[(\\d+)\\][^\\n]*' + card + '[^\\n]*'));
    if (m) { await page.click(+m[1]); methodLabel = card; }
  }
}

await sleep(300);
const s2 = await page.get({});
const ok = s2.tree.includes(methodLabel) || s2.tree.includes(card);
return { ok, method: methodLabel, popup_url };
