// 정가 = goods-detail.musinsa.com api2 의 goodsPrice.normalPrice (poizon-sourcing 스킬 규칙). 세일가(salePrice)·예상가(finalPrice)는 참고만
const out={normal_price:null,sale_price:null,final_price:null,goods_no:null,note:null};
const sku=String(args.sku||'');
const m=sku.match(/products\/(\d+)/)||sku.match(/^(\d{5,})$/);
if(!m){out.note='goods_no 를 알 수 없다';return out;}
out.goods_no=m[1];
const pf=args.profile?{profile:args.profile}:{};
const t=await tabs.open({...pf,url:'https://goods-detail.musinsa.com/api2/goods/'+m[1]+'?goodsSaleType=SALE'});
let tx='';
for(let i=0;i<6;i++){await sleep(700);const g=await page.get({interactive:false});tx=g.tree.slice(g.tree.indexOf('PAGE TEXT:'));if(/normalPrice/.test(tx))break;}
for(const x of await tabs.list()){if(/goods-detail\.musinsa\.com/.test(x.url||'')){try{await tabs.close(x.id);}catch(e){}}}
const n=tx.match(/"normalPrice"\s*:\s*(\d+)/),s=tx.match(/"salePrice"\s*:\s*(\d+)/),f=tx.match(/"finalPrice"\s*:\s*(\d+)/);
if(n)out.normal_price=parseInt(n[1]);if(s)out.sale_price=parseInt(s[1]);if(f)out.final_price=parseInt(f[1]);
if(!n)out.note='normalPrice 없음';
return out;