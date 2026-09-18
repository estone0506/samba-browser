import { describe, it, expect } from 'vitest'
import { parsePasswordCsv, normalizeHost } from '../src/main/import/passwords-csv'

describe('normalizeHost', () => {
  it('소문자로 변환하고 www. 접두사를 제거한다', () => {
    expect(normalizeHost('https://WWW.Example.com/path')).toBe('example.com')
  })

  it('포트를 제거한다', () => {
    expect(normalizeHost('http://example.com:8080/login')).toBe('example.com')
  })

  it('스킴이 없으면 호스트로 간주한다', () => {
    expect(normalizeHost('example.com')).toBe('example.com')
    expect(normalizeHost('www.example.com:443')).toBe('example.com')
  })

  it('유효하지 않은 값은 빈 문자열을 반환한다', () => {
    expect(normalizeHost('')).toBe('')
    expect(normalizeHost('not a url at all')).toBe('')
  })

  it('끝에 점(FQDN 루트 표기)이 있으면 제거한다', () => {
    expect(normalizeHost('example.com.')).toBe('example.com')
    expect(normalizeHost('https://WWW.Example.com./path')).toBe('example.com')
  })
})

describe('parsePasswordCsv', () => {
  it('크롬/웨일/엣지 헤더(name,url,username,password,note)를 파싱한다', () => {
    const csv = [
      'name,url,username,password,note',
      'Example,https://www.example.com,user1,pass1,메모'
    ].join('\n')
    const { rows, skipped } = parsePasswordCsv(csv)
    expect(skipped).toBe(0)
    expect(rows).toEqual([
      {
        name: 'Example',
        url: 'https://www.example.com',
        host: 'example.com',
        username: 'user1',
        password: 'pass1',
        note: '메모'
      }
    ])
  })

  it('따옴표로 감싼 쉼표와 개행이 포함된 값을 올바르게 파싱한다', () => {
    const csv =
      'name,url,username,password,note\n' +
      '"Site, Inc.",https://site.example.com,user2,pass2,"line1\nline2"'
    const { rows, skipped } = parsePasswordCsv(csv)
    expect(skipped).toBe(0)
    expect(rows[0].name).toBe('Site, Inc.')
    expect(rows[0].note).toBe('line1\nline2')
  })

  it('username 이 비어있는 행은 skipped 로 센다', () => {
    const csv = [
      'name,url,username,password,note',
      'NoUser,https://a.example.com,,pass3,',
      'Valid,https://b.example.com,user4,pass4,'
    ].join('\n')
    const { rows, skipped } = parsePasswordCsv(csv)
    expect(skipped).toBe(1)
    expect(rows).toHaveLength(1)
    expect(rows[0].username).toBe('user4')
  })

  it('password 가 비어있는 행은 skipped 로 센다', () => {
    const csv = [
      'name,url,username,password,note',
      'NoPass,https://c.example.com,user5,,',
      'Valid,https://d.example.com,user6,pass6,'
    ].join('\n')
    const { rows, skipped } = parsePasswordCsv(csv)
    expect(skipped).toBe(1)
    expect(rows).toHaveLength(1)
    expect(rows[0].username).toBe('user6')
  })

  it('비트워든 헤더 별칭(login_uri,login_username,login_password,notes)을 인식한다', () => {
    const csv = [
      'name,login_uri,login_username,login_password,notes',
      'Bit Site,https://bit.example.com,buser,bpass,bnote'
    ].join('\n')
    const { rows, skipped } = parsePasswordCsv(csv)
    expect(skipped).toBe(0)
    expect(rows[0]).toEqual({
      name: 'Bit Site',
      url: 'https://bit.example.com',
      host: 'bit.example.com',
      username: 'buser',
      password: 'bpass',
      note: 'bnote'
    })
  })

  it('사파리/키퍼 헤더(Title,URL,Username,Password,Notes 대소문자 무관)를 인식한다', () => {
    const csv = [
      'Title,URL,Username,Password,Notes',
      'Safari Site,https://safari.example.com,suser,spass,snote'
    ].join('\n')
    const { rows, skipped } = parsePasswordCsv(csv)
    expect(skipped).toBe(0)
    expect(rows[0]).toEqual({
      name: 'Safari Site',
      url: 'https://safari.example.com',
      host: 'safari.example.com',
      username: 'suser',
      password: 'spass',
      note: 'snote'
    })
  })

  it('파이어폭스 헤더(url,username,password, name 없음)는 호스트로 name 을 채운다', () => {
    const csv = ['url,username,password', 'https://firefox.example.com,fuser,fpass'].join('\n')
    const { rows, skipped } = parsePasswordCsv(csv)
    expect(skipped).toBe(0)
    expect(rows[0].name).toBe('firefox.example.com')
    expect(rows[0].note).toBe('')
  })

  it('키퍼 헤더(Title,Login,Password,Website Address,Notes)를 인식한다', () => {
    const csv = [
      'Title,Login,Password,Website Address,Notes',
      'Keeper Site,kuser,kpass,https://keeper.example.com,knote'
    ].join('\n')
    const { rows, skipped } = parsePasswordCsv(csv)
    expect(skipped).toBe(0)
    expect(rows[0]).toEqual({
      name: 'Keeper Site',
      url: 'https://keeper.example.com',
      host: 'keeper.example.com',
      username: 'kuser',
      password: 'kpass',
      note: 'knote'
    })
  })

  it('BOM(\\uFEFF) 이 파일 앞에 있어도 정상 파싱된다', () => {
    const csv =
      '﻿' +
      ['name,url,username,password,note', 'Bom Site,https://bom.example.com,buser,bpass,'].join(
        '\n'
      )
    const { rows, skipped } = parsePasswordCsv(csv)
    expect(skipped).toBe(0)
    expect(rows[0].name).toBe('Bom Site')
    expect(rows[0].username).toBe('buser')
  })

  it('CRLF 줄바꿈이어도 정상 파싱된다', () => {
    const csv = [
      'name,url,username,password,note',
      'Crlf Site,https://crlf.example.com,cuser,cpass,'
    ].join('\r\n')
    const { rows, skipped } = parsePasswordCsv(csv)
    expect(skipped).toBe(0)
    expect(rows[0].name).toBe('Crlf Site')
    expect(rows[0].username).toBe('cuser')
  })

  it('끝에 빈 줄이 있어도 빈 행으로 카운트되지 않는다', () => {
    const csv =
      ['name,url,username,password,note', 'Trail Site,https://trail.example.com,tuser,tpass,'].join(
        '\n'
      ) + '\n\n\n'
    const { rows, skipped } = parsePasswordCsv(csv)
    expect(skipped).toBe(0)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Trail Site')
  })
})
