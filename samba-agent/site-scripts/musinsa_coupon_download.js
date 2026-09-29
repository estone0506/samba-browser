const sku=String(args.sku||'');const url=/^http/.test(sku)?sku:'https://www.musinsa.com/products/'+sku;
if(!/^http/.test(sku)&&!/^\d{5,}$/.test(sku))return{ok:false,note:'bad sku'};
const before=new Set((await tabs.list()).map(t=>t.id));
await tabs.open({url,profile:args.profile||undefined});await sleep(4000);
try{await page.dismissOverlay()}catch(e){}
let g=await page.get({query:'쿠폰받기'});
const m=g.tree.match(/^\[(\d+)\] button "쿠폰받기"/m);
const close=async()=>{for(const t of await tabs.list())if(!before.has(t.id))try{await tabs.close(t.id)}catch(e){}};
if(!m){await close();return{ok:true,clicked:false,issued:[]}}
await page.click(+m[1]);await sleep(2500);
g=await page.get({interactive:true});
const all=g.tree.match(/^\[(\d+)\] button "(?:모두 받기|전체 받기|쿠폰 모두 받기|전체 쿠폰 받기)"/m);
if(all){await page.click(+all[1]);await sleep(2000);g=await page.get({interactive:true});}
const issued=[...g.tree.matchAll(/radio "([\d,]+)원 할인[^"]*발급완료/g)].map(x=>x[1]);
const c=g.tree.match(/^\[(\d+)\] button "레이어 닫기"/m);if(c){await page.click(+c[1]);await sleep(500);}
await close();
return{ok:true,clicked:true,issued};
