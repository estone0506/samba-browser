
function readTotal(text){
  const idx = text.lastIndexOf('최종 결제 금액');
  if (idx<0) return null;
  const seg = text.slice(idx, idx+40);
  const m = seg.match(/([\d,]+)\s*원/);
  return m ? parseInt(m[1].replace(/,/g,''),10) : null;
}
const all = await tabs.list();
const cands = all.filter(t=>t.kind==='tab' && /smarket\.co\.kr\/order\/order/.test(t.url));
if (!cands.length) return {quotes:[], base_cost:null, note:'no smarket order tab open'};
const tab = cands[cands.length-1];
await tabs.switch(tab.id);

let s = await page.get({});
const base = readTotal(s.tree);
if (base==null) return {quotes:[], base_cost:null, note:'could not read 최종 결제 금액'};

const KW = '일반결제|에스크로결제|신용카드|계좌이체|가상계좌|무통장입금|카카오페이|네이버페이|토스페이|페이코|휴대폰결제';
const flatIdx = s.tree.indexOf('결제수단 선택');
const flatEnd = s.tree.indexOf('결제하기', flatIdx);
const payText = flatIdx>=0 ? s.tree.slice(flatIdx, flatEnd>flatIdx?flatEnd:undefined) : '';
const tokens = payText.match(new RegExp(KW,'g')) || [];
let group=null; const seq=[];
for (const tok of tokens){
  if (tok==='일반결제'||tok==='에스크로결제'){ group=tok; continue; }
  seq.push({group, text:tok});
}
const idRe = new RegExp('^\\[(\\d+)\\]\\s*label\\s*"('+KW+')"');
const idSeq=[];
for (const line of s.tree.split('\n')){ const m=line.match(idRe); if(m) idSeq.push(parseInt(m[1],10)); }
const items = seq.map((x,i)=>({...x,id: idSeq[i]})).filter(x=>x.id);

if (!items.length) return {quotes:[], base_cost: base, note:'no payment methods found on order form'};

const wanted = (args.methods && args.methods.length) ? args.methods : null;
const quotes=[];
let firstId = items[0].id;
for (const it of items){
  const label = it.group + ' ' + it.text;
  if (wanted && !wanted.some(w=> it.text.includes(w) || label.includes(w))) continue;
  await page.click(it.id);
  await sleep(800);
  let s2 = await page.get({});
  let cost = readTotal(s2.tree);

  if (/카드/.test(it.text)){
    const selMatch = s2.tree.match(/\[(\d+)\]\s*(?:combobox|select)[^\n]*카드사/);
    if (selMatch){
      const selId = parseInt(selMatch[1],10);
      const optM = s2.tree.match(new RegExp('\\['+selId+'\\][^\n]*\\n((?:\\s*-\\s*"[^"]+"\\n?)+)'));
      const cardNames = optM ? (optM[1].match(/"([^"]+)"/g)||[]).map(x=>x.replace(/"/g,'')).filter(n=>n && n!=='선택') : [];
      let count=0;
      for (const cn of cardNames){
        if (count>=12) break;
        await page.select(selId, cn);
        await sleep(800);
        const s3 = await page.get({});
        quotes.push({method: label, card: cn, cost: readTotal(s3.tree)});
        count++;
      }
      if (cardNames.length) continue;
    }
  }
  quotes.push({method: label, card: null, cost});
}

if (items[0]) { await page.click(firstId); await sleep(500); }

return {quotes, base_cost: base, note: quotes.length ? null : 'no methods matched args.methods'};
