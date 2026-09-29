
function rows(tree) {
  let out = [];
  for (let line of tree.split('\n')) {
    let m = line.match(/^\[(\d+)\]\s+\S+\s+"([^"]*)"/);
    if (m) out.push({ id: Number(m[1]), name: m[2] });
  }
  return out;
}
let openOpts = args.profile ? { profile: args.profile } : {};
let url = args.sku;
if (!/^https?:\/\//.test(url)) {
  await tabs.open({ url: `https://www.rexmonde.com/products/list?search_keyword=${encodeURIComponent(args.sku)}&search_type=`, ...openOpts });
  await sleep(1200);
  await page.dismissOverlay();
  let l = await page.get({ selector: 'a[href*="/products/view"]' });
  let list = rows(l.tree);
  if (!list.length) return { error: 'product-not-found', options: [], already_ordered: false, coupons: [], methods: [], cost: null, margin_pct: null, product_url: null, account: args.account || null };
  await page.click(list[0].id);
  await sleep(1200);
} else {
  await tabs.open({ url, ...openOpts });
  await sleep(1200);
}
await page.dismissOverlay();
await sleep(300);
let opener = await page.idOf('색상 및 사이즈를 선택', 0);
if (opener === -1) opener = await page.idOf('옵션을 선택', 0);
if (opener !== -1) { await page.click(opener); await sleep(1800); }
let s = await page.get({});
let allRows = rows(s.tree).filter(e => /원$/.test(e.name.trim()));
let options = allRows.map(e => e.name);
let picked = -1;
if (args.size) {
  let norm = args.size.toString().toLowerCase().replace(/[\s-]/g, '');
  let match = allRows.find(e => e.name.toLowerCase().replace(/[\s-]/g, '').includes(norm));
  if (match) picked = match.id;
}
if (picked === -1 && allRows.length === 1) picked = allRows[0].id;
if (picked === -1) {
  return { options, already_ordered: false, coupons: [], methods: [], cost: null, margin_pct: null, product_url: await page.url(), account: args.account || null, note: 'size-not-matched' };
}
await page.click(picked);
await sleep(700);
let buyBtn = await page.idOf('즉시구매', 0);
if (buyBtn === -1) return { options, already_ordered: false, coupons: [], methods: [], cost: null, margin_pct: null, product_url: await page.url(), account: args.account || null, note: 'buy-button-not-found' };
await page.click(buyBtn);
await sleep(1800);
await page.dismissOverlay();
let o = await page.get({});
let text = o.tree;
let methods = rows(text).filter(e => /페이|카드|입금|계좌|결제/.test(e.name)).map(e => e.name);
let couponMatch = text.match(/즉시할인[^\n]{0,40}/);
let coupons = couponMatch ? [couponMatch[0]] : [];
let costMatch = text.match(/최종 결제금액\s*([\d,]+)/);
let cost = costMatch ? costMatch[1] : null;
return { options, already_ordered: false, coupons, methods, cost, margin_pct: null, product_url: await page.url(), account: args.account || null };
