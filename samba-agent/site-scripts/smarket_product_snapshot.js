// 2026-09-27: 사이즈 못 찾으면 기본 사이즈로 사던 것을 멈춤으로, '구매 불가'는 확정 품절로

function bodyText(s){ const t = s.tree || ""; const i = t.indexOf("PAGE TEXT:"); return i===-1 ? t : t.slice(i+10).trim(); }
const isUrl = /^https?:\/\//i.test(args.sku);
const openOpt = { ...(args.profile ? { profile: args.profile } : {}) };
if (isUrl) {
  await tabs.open({ ...openOpt, url: args.sku });
} else {
  await tabs.open({ ...openOpt, url: "https://www.smarket.co.kr/goods/goods_search.php?keyword=" + encodeURIComponent(args.sku) });
}
let t = [...(await tabs.list())].reverse()[0];
await tabs.switch(t.id);
await sleep(1200);
if (!isUrl) {
  let s = await page.get({ selector: 'a[href*="goods_view.php"]', interactive: true });
  if (!s.elements.length) return { error: "no search result" };
  await page.click(s.elements[0].id);
  await sleep(1200);
}
const product_url = await page.url();
// 상품 전체 품절이면 구매 버튼이 '구매 불가'(btn_add_soldout, 비활성)로만 나온다 — 선택지에 품절 표시가 없어도 못 산다(2026-09-27 실측 5896·6362)
if ((await page.idOf("구매 불가")) !== -1) return { sold_out: true, error: "sold_out", note: "구매 불가(상품 전체 품절)", product_url };
let optS = await page.get({ selector: '.item_option, .option_wrap, [class*="option"]' });
const options = bodyText(optS).split(/\s{2,}|\n+/).map(x=>x.trim()).filter(Boolean);
let note = "";
if (args.size) {
  const sid = await page.idOf(String(args.size));
  if (sid !== -1) { await page.click(sid); await sleep(500); }
  else return { error: "option_not_found", note: "주문 사이즈 선택지 없음: " + args.size, product_url };
}
const buyId = await page.idOf("바로구매");
if (buyId === -1) return { error: "no 바로구매 button", options, product_url };
await page.click(buyId);
await sleep(2000);
let url = await page.url();
if (!/order\.php/.test(url)) {
  await sleep(1500);
  url = await page.url();
}
if (!/order\.php/.test(url)) {
  return { error: "could not reach order form (out of stock?)", options, product_url, note };
}
let coupons = {};
const couponBtnId = await page.idOf("쿠폰 조회 및 적용");
if (couponBtnId !== -1) {
  await page.click(couponBtnId);
  await sleep(700);
  const cs = await page.get({ selector: '#couponOrderApplyLayer' });
  const ctext = bodyText(cs);
  const dm = ctext.match(/총 할인금액\s*([\d,]+)원/);
  coupons[args.account || "현재 로그인 계정"] = dm ? parseInt(dm[1].replace(/,/g,""),10) : 0;
  const cancelId = await page.idOf("취소");
  if (cancelId !== -1) await page.click(cancelId);
  await sleep(300);
} else {
  coupons[args.account || "현재 로그인 계정"] = 0;
}
const full = await page.get({});
const text = bodyText(full);
const cm = text.match(/최종 결제 금액\s*([\d,]+)원/);
const cost = cm ? parseInt(cm[1].replace(/,/g,""),10) : null;
const methods = [...new Set([...text.matchAll(/신용카드|계좌이체|가상계좌|무통장입금|간편결제/g)].map(x=>x[0]))];
const account = null;
const already_ordered = false;
return { options, already_ordered, coupons, methods, cost, margin_pct: null, product_url, account };
