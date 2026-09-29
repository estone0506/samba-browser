// 롯데온 선물 주문서: '받는 분 주소로 보내기' → 배송지 선택 창에서 이름·도로명이 같은 기존 배송지를 고르고 선택완료 → 빠른 선물 켬.
// 직배 주문서(선물 시트 아님)면 ok:false(기존 선택 없음 — set_shipping 이 맡는다). args: name, address, address_detail, profile
// 반환 {ok, name, address, note}. 이름의 '*' 은 롯데온이 거부해 'O' 로 저장돼 있다 — 대조는 원래 이름으로 돌려준다
function pe(t){const o=[];for(const l of t.split('\n')){const m=l.match(/^\[(\d+)\]\s+(\S+)(?:\s+"([^"]*)")?(?:\s+name=\S+)?(?:\s+value="([^"]*)")?/);if(m)o.push({id:+m[1],role:m[2],text:m[3]||'',value:m[4]!==undefined?m[4]:null});}return o;}
const G=async(q,sel)=>page.get(q?{query:q}:(sel?{selector:sel,interactive:true}:{}));
const els=async(q,sel)=>pe((await G(q,sel)).tree);
const text=async sel=>((await G(null,sel)).tree.split('PAGE TEXT:')[1]||'').replace(/\s+/g,' ');
const A=args||{};const name0=String(A.name||'').trim();const name=name0.replace(/\*/g,'O');
const addr=String(A.address||'').trim();const det=String(A.address_detail||'').trim();
const full=det.startsWith(addr)?det:addr;
const m=full.match(/^(.*?(?:로|길)\s+\d+(?:-\d+)?)(?![\d-])/)||full.match(/^(.*?(?:로|길)\d+(?:-\d+)?)(?![\d-])/);
const road=(m?m[1]:addr).replace(/\s/g,'').slice(-8);
const R={ok:false,name:null,address:null,note:null};
if(!name||!addr)return{...R,note:'name/address missing'};
const rr=(await els('받는 분 주소로 보내기')).filter(e=>e.role==='radio'&&/주소로/.test(e.text));
if(!rr.length)return{...R,note:'선물 주문서 아님(받는 분 주소로 보내기 없음)'};
await page.click(rr[0].id);await sleep(1500);
let b=(await els('배송지 선택하기')).find(e=>e.role==='button'&&/배송지 선택하기/.test(e.text))||(await els('배송지 수정하기')).find(e=>e.role==='button'&&/배송지 수정하기/.test(e.text));
if(!b)return{...R,note:'배송지 선택 버튼 없음'};
await page.click(b.id);await sleep(2500);
let L=await els(null,'[role=dialog]');let tx=await text('[role=dialog]');
const labs=L.filter(e=>e.role==='label'&&e.text.includes(name));
if(!(labs.length&&tx.replace(/\s/g,'').includes(road))){
  const c=L.find(e=>e.role==='button'&&e.text==='닫기');if(c)await page.click(c.id);
  return{...R,note:'목록에 같은 배송지 없음'};
}
const lid=labs[labs.length-1].id;const rid=Math.max(...L.filter(e=>e.role==='radio'&&e.id<lid).map(e=>e.id),0);
if(!rid)return{...R,note:'배송지 라디오 없음'};
await page.click(rid);await sleep(800);
const done=(await els('선택완료')).find(e=>e.role==='button'&&e.text==='선택완료');
if(!done)return{...R,note:'선택완료 없음'};
await page.click(done.id);await sleep(3000);
tx=await text();
if(!tx.includes(name))return{...R,note:'선택 뒤 주문서에 받는 분 이름 없음'};
let cb=(await els('빠른 선물')).find(e=>e.role==='checkbox');
if(cb&&cb.value!=='on'){await page.click(cb.id);for(let k=0;k<8&&(!cb||cb.value!=='on');k++){await sleep(800);cb=(await els('빠른 선물')).find(e=>e.role==='checkbox');}}
if(!cb||cb.value!=='on')return{...R,name:name0,address:addr,note:'빠른 선물 못 켬'};
return{ok:true,name:name0,address:addr,address_detail:det||null,note:null,quick_gift:true};
