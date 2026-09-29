
const open_ = args.profile ? {profile: args.profile} : {};
const isUrl = /^https?:\/\//i.test(args.sku||'');
const startUrl = isUrl ? args.sku : ('https://www.gsshop.com/search/search.gs?kwd=' + encodeURIComponent(args.sku||''));
let t0 = await tabs.open({...open_, url: startUrl});
await sleep(1200);
let t = [...(await tabs.list())].reverse().find(x=>x.id===t0.id) || t0;
await tabs.switch(t.id);
await sleep(500);
if (!/\/prd\/prd\.gs/.test(await page.url())) {
  const pg = await page.get({});
  const m = pg.tree.match(/\/prd\/prd\.gs\?prdid=\d+[^\s"]*/);
  if (!m) return {error:'no product found', sku: args.sku};
  const url2 = 'https://www.gsshop.com' + m[0];
  t0 = await tabs.open({...open_, url: url2});
  await sleep(1200);
  t = [...(await tabs.list())].reverse().find(x=>x.id===t0.id) || t0;
  await tabs.switch(t.id);
  await sleep(500);
}
const product_url = await page.url();
async function trig(label){
  const id1 = await page.idOf(label,1);
  const id0 = await page.idOf(label,0);
  const id = (id1>=0)?id1:id0;
  if (id>=0){ await page.click(id); await sleep(400); }
  return id;
}
function parseOpts(tree, label, endLabel){
  const i = tree.indexOf('옵션');
  if (i<0) return [];
  const seg = tree.slice(i, i+400);
  const a = seg.indexOf(label); if(a<0) return [];
  const b = seg.indexOf(endLabel, a+label.length);
  const chunk = seg.slice(a+label.length, b<0?a+label.length+100:b).trim();
  return chunk.split(/\s+/).filter(w=>w && w!=='색상' && w!=='사이즈');
}
let parts = (args.size||'').split('/').map(s=>s.trim()).filter(Boolean);
await trig('색상');
let g1 = await page.get({});
let colors = parseOpts(g1.tree, '색상', '사이즈');
let colorWant = parts.length>1 ? parts[0] : null;
let colorPick = colorWant ? (colors.find(c=>c.includes(colorWant))||colors[0]) : colors[0];
if (colorPick) { await page.clickText(colorPick); await sleep(400); }
await trig('사이즈');
let g2 = await page.get({});
let sizes = parseOpts(g2.tree, colorPick||'색상', '총');
let sizeWant = parts.length ? parts[parts.length-1] : (args.size||'');
let sizePick = sizeWant ? (sizes.find(s=>s===sizeWant)||sizes.find(s=>s.includes(sizeWant))||sizes[0]) : sizes[0];
if (sizePick) { await page.clickText(sizePick); await sleep(400); }
const options = { colors, sizes, picked: (colorPick||'') + (sizePick? ('/'+sizePick):'') };
const buyId = await page.idOf('바로구매',1);
if (buyId>=0){ await page.click(buyId); }
let ordUrl = await page.url();
for (let i=0;i<8 && !/\/ord\//.test(ordUrl);i++){ await sleep(700); ordUrl = await page.url(); }
if (!/\/ord\//.test(ordUrl)) return {options, product_url, error:'order form not opened', url: ordUrl};
await sleep(500);
const g3 = await page.get({});
const tree = g3.tree;
const costM = tree.match(/결제하실\s*금액\s*([\d,]+)\s*원/);
const cost = costM ? parseInt(costM[1].replace(/,/g,''),10) : null;
const methods = ['GS Pay 간편결제','신용카드','현금결제','휴대폰결제','네이버페이','페이코','카카오페이','토스'].filter(m=>tree.includes(m));
const acctKey = args.account || '현재 로그인 계정';
const coupons = {}; coupons[acctKey] = 0;
return { options, already_ordered:false, coupons, methods, cost, margin_pct:null, product_url, account:null };
