
const list = await tabs.list();
const t = [...list].reverse().find(x => /\/ord\/ordsht\/ordSht\.gs/.test(x.url||''));
if (!t) return {error:'no order form tab open'};
await tabs.switch(t.id);
await sleep(300);
const easy = ['토스','카카오페이','네이버페이','페이코'];
const wantEasy = easy.find(e => (args.card||'').includes(e));
let method = '';
if ((args.card||'').includes('GS Pay')) {
  const id = await page.idOf('GS Pay 간편결제',0);
  if (id>=0){ await page.click(id); method='GS Pay 간편결제'; }
} else if (wantEasy) {
  const otherId = await page.idOf('다른 결제 수단',0);
  if (otherId>=0){ await page.click(otherId); await sleep(300); }
  const id = await page.idOf(wantEasy,0);
  if (id>=0){ await page.click(id); method=wantEasy; }
} else {
  const otherId = await page.idOf('다른 결제 수단',0);
  if (otherId>=0){ await page.click(otherId); await sleep(300); }
  const crId = await page.idOf('신용카드',0);
  if (crId>=0){ await page.click(crId); await sleep(300); }
  const g = await page.get({selector:'select[name="pay_slt_card"]'});
  method = '신용카드:' + (args.card||'');
  try { await page.select(await (async()=>{ const gg=await page.get({}); const mm=gg.tree.match(/\[(\d+)\]\s+combobox[^\n]*name=pay_slt_card/); return mm?parseInt(mm[1],10):-1; })(), args.card||''); } catch(e){}
}
await sleep(400);
const agreeAllId = await page.idOf('위 주문의 상품, 가격, 할인, 배송정보에 동의합니다.',0);
if (agreeAllId>=0){ await page.click(agreeAllId); await sleep(300); }
const agreeId = await page.idOf('결제서비스 이용에 동의합니다.',0);
if (agreeId>=0){ await page.click(agreeId); await sleep(300); }
const payBtn = await page.idOf('결제하기',0);
if (payBtn<0) return {ok:false, error:'no pay button', method};
await page.click(payBtn);
await sleep(2000);
const after = await tabs.list();
const before = list.map(x=>x.id);
const popup = after.find(x=>!before.includes(x.id));
return { ok:true, method, popup_url: popup ? popup.url : null };
