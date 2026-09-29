
const card = args.card || '';
const cardCompanies=['롯데카드','신한카드','KB국민카드','삼성카드','현대카드','BC카드','하나카드','씨티카드','우리BC카드','우리카드','NH농협카드','카카오뱅크','광주카드'];
const simplePays=['카카오페이','네이버페이','토스페이','삼성페이','휴대폰결제','충전결제','퀵계좌이체','온누리상품권'];
const url = await page.url();
if (!/orderSheet/.test(url)) return {ok:false, error:'no lotteon order sheet open in current tab'};
// 결제 단계가 아니면(선물·직배 주문서 첫 화면) '계속하기'로 넘어간다
for (let i = 0; i < 6 && !/결제수단/.test((await page.get({query:'결제수단'})).tree); i++) {
  const c = await page.idOf('계속하기'); if (c < 0) break; await page.click(c); await sleep(2500);
}
// L.POINT 전액 사용(사용자 2026-09-27) — 버튼이 있을 때만
const fu = await page.idOf('전액사용'); if (fu >= 0) { await page.click(fu); await sleep(2500); }
let method=null;
const mc = cardCompanies.find(c=>c.includes(card)||(card && card.length>0 && c.replace('카드','').includes(card)));
if (mc) {
  await page.clickText('신용카드');
  await sleep(600);
  const sel = await page.idOf('카드를 선택해 주세요.');
  if (sel<0) return {ok:false, error:'card select box not found'};
  await page.click(sel);
  await sleep(600);
  await page.clickText(mc);
  method = mc;
} else {
  const mp = simplePays.find(p=>p.includes(card)||(card && card.length>0 && p.includes(card)));
  if (!mp) return {ok:false, error:'payment method not found: '+card};
  await page.clickText(mp);
  method = mp;
}
await sleep(600);
const payId = await page.idOf('결제하기');
if (payId<0) return {ok:false, error:'결제하기 button not found', method};
await page.click(payId);
await sleep(3000);
// 네이버페이는 같은 탭에서 m.pay.naver.com 으로 넘어가 '동의하고 결제하기' 뒤 비밀번호 키패드가 뜬다(팝업 아님)
if (/네이버페이/.test(method)) {
  for (let i = 0; i < 8; i++) { const ag = await page.idOf('동의하고 결제하기'); if (ag >= 0) { await page.click(ag); await sleep(3000); break; } await sleep(1000); }
}
const tbs = await tabs.list();
const popup = tbs.find(t=>t.kind==='popup');
return { ok:true, method, popup_url: popup? popup.url : null, keypad_in_tab: /네이버페이/.test(method) };
