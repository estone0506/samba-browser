
function idOfName(tree, name) {
  let m = tree.match(new RegExp('\\[(\\d+)\\][^\\n]*name='+name+'\\b'));
  return m ? Number(m[1]) : -1;
}
let s = await page.get({});
if (!(await page.url()).includes('order_view')) {
  return { error: 'not-on-order-view', name: null, address: null, phone: null, phone_field_ids: [] };
}
let nameId = idOfName(s.tree, 'recv_name');
let addrId = idOfName(s.tree, 'recv_addr');
let memoChooseId = idOfName(s.tree, 'shipping_memo_choose');
let memoId = idOfName(s.tree, 'shipping_memo');
let phoneId = idOfName(s.tree, 'recv_phone');
if (nameId !== -1 && args.name) await page.type(nameId, args.name);
if (addrId !== -1 && args.address) await page.type(addrId, args.address);
if (memoChooseId !== -1 && args.memo) {
  await page.select(memoChooseId, '직접 입력하기');
  await sleep(300);
}
if (memoId !== -1 && args.memo) await page.type(memoId, args.memo);
return {
  name: args.name || null,
  address: args.address || null,
  phone: null,
  phone_field_ids: phoneId !== -1 ? [phoneId] : []
};
