import { describe, it, expect } from 'vitest'
import { registrableDomain } from '../src/shared/host'

describe('registrableDomain', () => {
  it('일반 도메인은 서브도메인을 떼고 eTLD+1 을 돌려준다(네이버 실검수 케이스)', () => {
    expect(registrableDomain('nid.naver.com')).toBe('naver.com')
  })

  it('일반 도메인 서브도메인(쿠팡)도 eTLD+1 로 정리한다', () => {
    expect(registrableDomain('login.coupang.com')).toBe('coupang.com')
  })

  it('공유 호스팅(vercel.app·github.io 등)은 사용자 서브도메인까지 등록 도메인으로 본다', () => {
    expect(registrableDomain('attacker.vercel.app')).toBe('attacker.vercel.app')
    expect(registrableDomain('victim.vercel.app')).not.toBe(registrableDomain('attacker.vercel.app'))
    expect(registrableDomain('me.github.io')).toBe('me.github.io')
    expect(registrableDomain('blog.tistory.com')).toBe('blog.tistory.com')
  })

  it('co.kr 처럼 2단계 공공 접미사는 그 앞 라벨까지 포함한다(11번가)', () => {
    expect(registrableDomain('www.11st.co.kr')).toBe('11st.co.kr')
  })

  it('co.kr 2단계 접미사 + 다른 서브도메인(크림)도 동일하게 처리한다', () => {
    expect(registrableDomain('m.kream.co.kr')).toBe('kream.co.kr')
  })

  it('이미 eTLD+1 인 호스트는 그대로 돌려준다', () => {
    expect(registrableDomain('naver.com')).toBe('naver.com')
  })

  it('IP 주소는 그대로 돌려준다', () => {
    expect(registrableDomain('192.168.0.1')).toBe('192.168.0.1')
  })

  it('localhost 는 그대로 돌려준다', () => {
    expect(registrableDomain('localhost')).toBe('localhost')
  })

  it('대문자가 섞여 있어도 소문자 eTLD+1 로 정리한다', () => {
    expect(registrableDomain('Nid.Naver.COM')).toBe('naver.com')
  })
})
