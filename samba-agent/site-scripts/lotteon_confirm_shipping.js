// 롯데온 선물 주문서의 '새 배송지 등록' 폼(이름·전화·주소가 채워진 상태)을 저장 → 방금 저장한 배송지 선택 → 선택완료 → 빠른 선물 켬 → 주문서 되읽기.
// 직배 주문서(선물 시트 아님)면 set_shipping 이 이미 저장했으므로 주문서 되읽기만 한다. args: name, address, profile
function pe(t){const o=[];for(const l of t.split('\n')){const m=l.match(/^\[(\d+)\]\s+(\S+)(?:\s+"([^"]*)")?(?:\s+name=\S+)?(?:\s+value="([^"]*)")?/);if(m)o.push({id:+m[1],role:m[2],text:m[3]||'',value:m[4]!==undefined?m[4]:null});}return o;}
const G=async(q,sel)=>page.get(q?{query:q}:(sel?{selector:sel,interactive:true}:{}));
const els=async(q,sel)=>pe((await G(q,sel)).tree);
const text=async sel=>((await G(null,sel)).tree.split('PAGE TEXT:')[1]||'').replace(/\s+/g,' ');
const A=args||{};const name0=String(A.name||'').trim();const name=name0.replace(/\*/g,'O');const addr=String(A.address||'').trim();
const R={ok:false,name:null,address:null,note:null};
const dlg=await els(null,'[role=dialog]');
if(dlg.some(e=>e.role==='button'&&e.text==='저장')){
  for(const c of dlg.filter(e=>e.role==='checkbox'&&/\(필수\)/.test(e.text)&&e.value!=='on'))await page.click(c.id);
  const sv=(await els(null,'[role=dialog]')).find(e=>e.role==='button'&&e.text==='저장');
  await page.click(sv.id);await sleep(4000);
  const L=await els(null,'[role=dialog]');
  const labs=L.filter(e=>e.role==='label'&&e.text.includes(name));
  if(!labs.length)return{...R,note:'저장 뒤 목록에 없음(이름 거부?)'};
  const lid=labs[labs.length-1].id;const rid=Math.max(...L.filter(e=>e.role==='radio'&&e.id<lid).map(e=>e.id),0);
  if(rid){await page.click(rid);await sleep(800);}
  const done=(await els('선택완료')).find(e=>e.role==='button'&&e.text==='선택완료');
  if(!done)return{...R,note:'선택완료 없음'};
  await page.click(done.id);await sleep(3000);
}
const tx=await text();
if(!tx.includes(name))return{...R,note:'주문서에 받는 분 이름 없음'};
let cb=(await els('빠른 선물')).find(e=>e.role==='checkbox');
if(cb){
  if(cb.value!=='on'){await page.click(cb.id);for(let k=0;k<8&&(!cb||cb.value!=='on');k++){await sleep(800);cb=(await els('빠른 선물')).find(e=>e.role==='checkbox');}}
  if(!cb||cb.value!=='on')return{...R,name:name0,address:addr,note:'빠른 선물 못 켬'};
}
return{ok:true,name:name0,address:addr,note:null,quick_gift:!!cb};
