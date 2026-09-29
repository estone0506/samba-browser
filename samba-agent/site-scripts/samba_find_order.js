
const orderNo = args.orderNo;
const searchType = args.searchType || '주문번호';

const periodId = await page.idOf('올해');
if (periodId !== -1) { await page.click(periodId); await sleep(300); }

const marketFilterId = await page.idOf('전체 마켓');
if (marketFilterId !== -1) { try { await page.select(marketFilterId, '전체 마켓'); } catch(e){} }
const sourceFilterId = await page.idOf('전체 소싱처');
if (sourceFilterId !== -1) { try { await page.select(sourceFilterId, '전체 소싱처'); } catch(e){} }
const statusFilterId = await page.idOf('전체 주문상태');
if (statusFilterId !== -1) { try { await page.select(statusFilterId, '전체 주문상태'); } catch(e){} }
await sleep(300);

const typeSelId = await page.idOf('상품명 고객명 상품ID 주문번호 소싱주문번호 송장번호');
await page.select(typeSelId, searchType);
await sleep(300);
await page.type(typeSelId + 1, orderNo, true);
await sleep(1200);

const s = await page.get({ selector: 'body' });
const tree = s.tree;
const marker = `상품주문번호 ${orderNo}`;
const mIdx = tree.indexOf(marker);
if (mIdx === -1) return { found: false, productOrderNo: orderNo };

const block = tree.slice(mIdx + marker.length, mIdx + marker.length + 1500);
const pre = tree.slice(Math.max(0, mIdx - 200), mIdx);

const nameMatch = block.match(/^\s*주문번호\s+(\S+)\s+([\s\S]*?)\[옵션\]\s*(\S+)/);
const marketOrderNo = nameMatch ? nameMatch[1] : null;
const productName = nameMatch ? nameMatch[2].trim() : null;
const option = nameMatch ? nameMatch[3] : null;
const sku = (productName && option) ? `${productName} [${option}]` : null;

const preMatch = pre.match(/수량:\s*(\d+)\s+(\S+)\s+(\S+)\s+SMS/);
const qty = preMatch ? Number(preMatch[1]) : null;
const market = preMatch ? preMatch[2] : null;
const sellerAccount = preMatch ? preMatch[3] : null;

const si = await page.get({ interactive: true, selector: 'body' });
const itree = si.tree;
const statusMatch = itree.match(/\[(\d+)\] combobox "주문접수 배송대기중[^"]*"\s*value="([^"]+)"/);
const status = statusMatch ? statusMatch[2] : null;
const acctMatch = itree.match(/\[(\d+)\] combobox "주문계정[^"]*"\s*value="([^"]+)"/);
const sourcingAccount = acctMatch ? acctMatch[2] : null;

// 원문링크(소싱처 상품 페이지) — 버튼이 새 창을 여니, 열린 탭의 주소만 읽고 바로 닫는다.
// 검색이 상품주문번호 1건으로 좁혀져 있어 첫 번째 원문링크 버튼이 이 주문의 것이다.
let sourceUrl = null;
try {
  const lm = itree.match(/\[(\d+)\] button "원문링크"/);
  if (lm) {
    const before = new Set((await tabs.list()).map(t => t.id));
    await page.click(parseInt(lm[1]));
    await sleep(900);
    const now = await tabs.list();
    const opened = now.find(t => !before.has(t.id));
    if (opened) {
      sourceUrl = opened.url || null;
      await tabs.close(opened.id);
    }
  }
} catch (e) {}

const platformMap = { MUSINSA: '무신사', '29CM': '29CM', ABCmart: 'ABC마트', LOTTEON: '롯데온' };
const sourcingPlatform = market ? (platformMap[market] || null) : null;

return {
  found: true,
  productOrderNo: orderNo,
  marketOrderNo,
  market,
  sellerAccount,
  qty,
  option,
  status,
  sourcingPlatform,
  sourcingAccount,
  productName,
  sku,
  sourceUrl
};
