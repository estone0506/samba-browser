// 롯데온 샵백 적립 진입 링크(사용자 2026-09-27: 롯데온은 샵백 경유). 샵백 로그인은 그 프로필의 확장앱(샵백)이 쥔다.
// 반환 {ok, entry_url} — 스냅샷이 이 링크로 들어가 롯데온에 착지한 뒤 같은 프로필의 새 탭에서 상품을 연다.
// args.entry_url 을 주면 그 링크를 쓴다(샵백 링크가 바뀌면 sources.yaml 쪽에서 덮어쓴다)
const A = args || {}
const url = String(A.entry_url || '').trim() || 'https://www.shopback.co.kr/redirect/alink/8075'
return { ok: true, entry_url: url, profile: A.profile || null, note: null }
