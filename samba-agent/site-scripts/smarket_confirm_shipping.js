
if (args.profile) {
  const t = (await tabs.list()).find(x => x.kind === 'tab' && /smarket\.co\.kr/.test(x.url) && /order\.php/.test(x.url));
  if (t) await tabs.switch(t.id);
}
// close stray popups (postcode search etc.)
for (const t of await tabs.list()) {
  if (t.kind === 'popup') { try { await tabs.close(t.id); } catch (e) {} }
}
await sleep(200);

function grab(tree, name) {
  const lines = tree.split('\n');
  const l = lines.find(x => x.includes('name=' + name + ' '));
  if (!l) return null;
  const m = l.match(/value="([^"]*)"/);
  return m ? m[1] : '';
}

let s = await page.get({ interactive: true });
const url = await page.url();
if (!/order\.php/.test(url)) {
  return { ok: false, note: 'not on smarket order.php' };
}

// if a save/apply button exists near shipping (site rarely has one; the fields
// are inline order-form inputs), click it once before re-reading.
const saveId = page.idOf('배송지 저장') !== -1 ? page.idOf('배송지 저장')
  : (page.idOf('이 배송지로 적용') !== -1 ? page.idOf('이 배송지로 적용') : -1);
if (saveId !== -1) {
  await page.click(saveId);
  await sleep(500);
  s = await page.get({ interactive: true });
}

const gotName = grab(s.tree, 'receiverName');
const gotAddress = grab(s.tree, 'receiverAddress');

if (gotName === null || gotAddress === null) {
  return { ok: false, note: 'shipping fields not found', name: gotName, address: gotAddress };
}

const nameOk = gotName === args.name;
const addrOk = !!gotAddress && (gotAddress === args.address || gotAddress.startsWith(args.address) || args.address.startsWith(gotAddress));

if (!nameOk || !addrOk) {
  return { ok: false, note: 'mismatch', name: gotName, address: gotAddress };
}

return { ok: true, name: gotName, address: gotAddress };
