
function rows(tree) {
  let out = [];
  for (let line of tree.split('\n')) {
    let m = line.match(/^\[(\d+)\]\s+\S+\s+"([^"]*)"/);
    if (m) out.push({ id: Number(m[1]), name: m[2] });
  }
  return out;
}
if (!(await page.url()).includes('order_view')) {
  return { error: 'not-on-order-view' };
}
let s = await page.get({});
let methods = rows(s.tree).filter(e => /radio/.test('') ).map(e=>e.name);
let payBtnMatch = s.tree.match(/\[(\d+)\][^\n]*"[\d,]+원 결제하기"/);
let payButtonId = payBtnMatch ? Number(payBtnMatch[1]) : -1;
let costMatch = s.tree.match(/최종 결제금액\s*([\d,]+)/);
let cost = costMatch ? costMatch[1] : null;
let radioLines = [];
for (let line of s.tree.split('\n')) {
  let m = line.match(/^\[(\d+)\]\s+radio\s+"([^"]*)"\s+name=payment_method/);
  if (m) radioLines.push({ id: Number(m[1]), name: m[2] });
}
return {
  cost,
  payButtonId,
  paymentMethods: radioLines,
  note: '저장만 함, 결제하기 클릭 안 함'
};
