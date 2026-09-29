
function readCost(tree){
  const idx = tree.indexOf('총 결제금액');
  if (idx<0) return null;
  const seg = tree.slice(idx, idx+400);
  let m = seg.match(/총\d+건\s*([\d,]+)/);
  if (!m) m = seg.match(/할인금액[^0-9]*[-\d,]+원\s*([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g,''),10) : null;
}
async function curCost(){ const s = await page.get({selector:'body'}); return readCost(s.tree); }
async function pickCard(name){
  const lid = await page.idOf('카드선택');
  if (lid < 0) return false;
  await page.click(lid); await sleep(400);
  let cid = await page.idOf(name);
  if (cid < 0) {
    // search-combobox fallback: type into the textbox to filter options
    const s = await page.get({query:'카드선택'});
    const tb = s.tree.match(/\[(\d+)\] textbox "카드선택"/);
    if (tb) {
      await page.type(parseInt(tb[1],10), name, false);
      await sleep(500);
      cid = await page.idOf(name);
    }
  }
  if (cid < 0) return false;
  await page.click(cid); await sleep(700); return true;
}

const list = await tabs.list();
let cands = list.filter(t => t.kind==='tab' && /lotteon\.com/.test(t.url) && /orderSheet\/one\/payments/.test(t.url));
if (!cands.length) cands = list.filter(t => t.kind==='tab' && /lotteon\.com/.test(t.url) && /orderSheet/.test(t.url));
if (!cands.length) return { quotes:[], base_cost:null, note:'no lotteon orderSheet tab open' };
await tabs.switch(cands[cands.length-1].id);
await sleep(300);

let chk = await page.get({selector:'body'});
if (!/결제수단/.test(chk.tree)) return { quotes:[], base_cost:null, note:'payments UI not found on target tab: '+page.url() };

const defMethods = ['신용카드','카카오페이','네이버페이','토스페이','삼성페이','휴대폰결제','퀵계좌이체','온누리상품권'];
const methods = (args.methods && args.methods.length) ? args.methods : defMethods;
const defCards = ['롯데카드','신한카드','KB국민카드','삼성카드','현대카드','BC카드','하나카드','씨티카드','우리카드','NH농협카드'];
const cards = (args.cards && args.cards.length) ? args.cards.slice(0,12) : defCards;

let base_cost = null;
for (let i = 0; i < 10 && base_cost == null; i++) { base_cost = await curCost(); if (base_cost == null) await sleep(800); }
if (base_cost == null) return { quotes:[], base_cost:null, note:'total not read on order sheet' };
const quotes = [];
let note = null;

for (const m of methods) {
  const mid = await page.idOf(m);
  if (mid < 0) { quotes.push({method:m, card:null, cost:null}); continue; }
  await page.click(mid); await sleep(800);
  if (m === '신용카드') {
    for (const c of cards) {
      const ok = await pickCard(c);
      quotes.push({method:m, card:c, cost: ok ? await curCost() : null});
    }
  } else {
    quotes.push({method:m, card:null, cost: await curCost()});
  }
}

const rid = await page.idOf('신용카드');
if (rid >= 0) {
  await page.click(rid); await sleep(800);
  const restored = await pickCard('롯데카드');
  if (!restored) note = 'restore to 롯데카드 failed, please check manually';
}

return { quotes, base_cost, note };
