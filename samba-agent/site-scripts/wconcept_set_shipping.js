
async function grab(sel){ const s = await page.get({selector: sel, interactive:true}); const m = s.tree.match(/\[(\d+)\][^\n]*value="([^"]*)"/); return m ? {id:+m[1], val:m[2]} : null; }
let changeId = await page.idOf('변경', 0);
if (changeId === -1) return { ok:false, error:'change-button-not-found' };
await page.click(changeId);
await sleep(700);
let newId = await page.idOf('새 배송지', 0);
let opened = false;
if (newId !== -1) {
  await page.click(newId);
  await sleep(700);
  const chk = await grab('[name=ajax_new_receivername]');
  if (chk) opened = true;
}
if (!opened) {
  const editId = await page.idOf('수정', 0);
  if (editId === -1) return { ok:false, error:'no-address-form-available' };
  await page.click(editId);
  await sleep(700);
}
const nameF = await grab('[name=ajax_new_receivername]');
if (!nameF) return { ok:false, error:'form-not-found' };
await page.type(nameF.id, args.name);
if (args.phone) {
  const digits = String(args.phone).replace(/\D/g,'');
  const mid = digits.length === 11 ? digits.slice(3,7) : digits.slice(-8,-4);
  const last = digits.slice(-4);
  const m2 = await grab('[name=ajax_new_mobile2]');
  const m3 = await grab('[name=ajax_new_mobile3]');
  if (m2) await page.type(m2.id, mid);
  if (m3) await page.type(m3.id, last);
}
const zipBtn = await page.idOf('우편번호 찾기', 0);
if (zipBtn !== -1) {
  await page.click(zipBtn);
  await sleep(700);
  const addrIn = await grab('[name=txtAddress]');
  if (addrIn) {
    await page.type(addrIn.id, args.address, true);
    await sleep(1000);
    const s = await page.get({ selector: 'a, li, [class*=result]', interactive:true });
    const m = s.tree.match(/\[(\d+)\][^\n]*도로명[^\n]*/);
    if (m) { await page.click(+m[1]); await sleep(600); }
  }
}
const addr2 = await grab('[name=ajax_new_orderaddr2]');
if (addr2 && args.address_detail) { await page.type(addr2.id, args.address_detail); }
const nameOut = await grab('[name=ajax_new_receivername]');
const addr1Out = await grab('[name=ajax_new_orderaddr1]');
const addr2Out = await grab('[name=ajax_new_orderaddr2]');
const m2Out = await grab('[name=ajax_new_mobile2]');
const m3Out = await grab('[name=ajax_new_mobile3]');
const phone_field_ids = [m2Out ? m2Out.id : null, m3Out ? m3Out.id : null].filter(x=>x);
return {
  name: nameOut ? nameOut.val : null,
  address: (addr1Out ? addr1Out.val : '') + (addr2Out ? (' ' + addr2Out.val) : ''),
  phone: args.phone ? ((m2Out?m2Out.val:'') + '-' + (m3Out?m3Out.val:'')) : null,
  phone_field_ids,
  ok: !!(nameOut && addr1Out)
};
