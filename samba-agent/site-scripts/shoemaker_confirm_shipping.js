
const s = await page.get({ selector: 'input[name="ReceiveName"], input[name="ReceiveAddr1"], input[name="ReceiveAddr2"]' });
const grab = (n) => {
  const m = s.tree.match(new RegExp('name=' + n + ' value="([^"]*)"'));
  return m ? m[1] : '';
};
const name = grab('ReceiveName');
const addr1 = grab('ReceiveAddr1');
const addr2 = grab('ReceiveAddr2');
const fieldAddr = (addr1 + addr2).replace(/\s+/g, '');

const nameOk = !args.name || name === args.name;

const addrArg = String(args.address || '');
const roadMatch = addrArg.match(/([가-힣0-9]+(?:대로|로|길))\s*(\d+)/);
const core = roadMatch ? (roadMatch[1] + roadMatch[2]) : addrArg.replace(/\s+/g, '');
const addressOk = fieldAddr.includes(core);

return {
  ok: nameOk && addressOk,
  name,
  address: (addr1 + ' ' + addr2).trim()
};
