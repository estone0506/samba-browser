
function parseEls(tree){const out=[];const re=/\[(\d+)\][^\n"]*"([^"]*)"/g;let m;while(m=re.exec(tree)){out.push({id:+m[1],text:m[2]});}return out;}
const openArgs = Object.assign({}, args.profile?{profile:args.profile}:{}, {url: args.sku && args.sku.startsWith('http') ? args.sku : ('https://display.wconcept.co.kr/search?type=direct&kwd=' + encodeURIComponent(args.sku))});
await tabs.open(openArgs);
await sleep(1200);
let list = [...(await tabs.list())].reverse();
let t = list.find(x => x.url && x.url.includes('wconcept.co.kr'));
if (!t) return {error:'tab-not-found'};
await tabs.switch(t.id);
await sleep(600);
if (!args.sku || !args.sku.startsWith('http')) {
  let s = await page.get({interactive:true});
  const els = parseEls(s.tree).filter(e => e.text && e.text.length > 6);
  if (els[0]) { await page.click(els[0].id); await sleep(1200); }
}
const product_url = await page.url();
let options = [];
if (args.size) {
  let s = await page.get({ query: args.size, interactive:true });
  const els = parseEls(s.tree);
  const match = els.find(e => e.text && e.text.includes(args.size));
  if (match) { await page.click(match.id); await sleep(400); options.push(match.text); }
}
let idxBuy = await page.idOf('바로 구매', 0);
if (idxBuy === -1) idxBuy = await page.idOf('바로구매', 0);
if (idxBuy === -1) return { error: 'buy-button-not-found', product_url, options };
await page.click(idxBuy);
await sleep(1800);
const s = await page.get({});
const text = s.tree;
const costMatch = text.match(/결제 예정금액[\s\S]{0,20}?([\d,]+)원/);
const cost = costMatch ? parseInt(costMatch[1].replace(/,/g,'')) : null;
const optMatch = text.match(/옵션\s*:\s*([^"\n]+)/);
if (optMatch && options.length === 0) options.push(optMatch[1].trim());
const methodsList = [];
[['SsgPay간편결제','SsgPay'],['SmilePay간편결제','SmilePay'],['일반결제','일반결제'],['W.페이','W.페이']].forEach(([label,needle])=>{ if (text.includes(needle)) methodsList.push(label); });
const account = args.account || '현재 로그인 계정';
const coupons = {}; coupons[account] = 0;
return { options, already_ordered:false, coupons, methods: methodsList, cost, margin_pct:null, product_url, account: null };
