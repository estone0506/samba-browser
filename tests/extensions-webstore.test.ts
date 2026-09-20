import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCrxUrl,
  downloadCrx,
  extractExtensionId,
  extractZip,
  installFromWebstore,
  MAX_UNZIPPED_BYTES,
  MAX_ZIP_ENTRIES,
  isAllowedCrxUrl,
  parseCrx3,
  parseCrxId,
  safeEntryPath
} from '../src/main/extensions/webstore'

// --- ZIP 픽스처 -----------------------------------------------------------------
// adm-zip 으로 만들면 테스트가 구현과 같은 코드를 쓰게 되니, 저장(store) 방식 ZIP 을
// 바이트로 직접 만든다. 경로 이탈 항목도 이 방식이라야 만들 수 있다
function crc32(buf: Buffer): number {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function makeZip(files: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8')
    const raw = Buffer.from(file.data, 'utf8')
    const compressed = deflateRawSync(raw)
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(Buffer.concat([local, nameBuf, compressed]))

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBuf]))

    offset += 30 + nameBuf.length + compressed.length
  }
  const localPart = Buffer.concat(locals)
  const centralPart = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralPart.length, 12)
  end.writeUInt32LE(localPart.length, 16)
  return Buffer.concat([localPart, centralPart, end])
}

/** 확장 id(a~p 32자) → 16바이트 crx_id */
function idToBytes(id: string): Buffer {
  const out = Buffer.alloc(16)
  for (let i = 0; i < 16; i++) {
    out[i] = ((id.charCodeAt(i * 2) - 97) << 4) | (id.charCodeAt(i * 2 + 1) - 97)
  }
  return out
}

/** CrxFileHeader { signed_header_data(10000) = SignedData { crx_id(1) = 16바이트 } } */
function crxHeaderFor(id: string): Buffer {
  const crxId = idToBytes(id)
  const signed = Buffer.concat([Buffer.from([0x0a, crxId.length]), crxId])
  // 필드 10000, wire type 2 → key = 80002 → varint [0x82, 0xF1, 0x04]
  return Buffer.concat([Buffer.from([0x82, 0xf1, 0x04, signed.length]), signed])
}

const DEFAULT_ID = 'cjpalhdlnbpafiamejdnhcphjbkeiagm'

/** [Cr24][version LE][header length LE][header][zip] */
function makeCrx(zip: Buffer, version = 3, header = crxHeaderFor(DEFAULT_ID)): Buffer {
  const head = Buffer.alloc(12)
  head.write('Cr24', 0, 'latin1')
  head.writeUInt32LE(version, 4)
  head.writeUInt32LE(header.length, 8)
  return Buffer.concat([head, header, zip])
}

describe('웹스토어 주소에서 확장 id 뽑기', () => {
  it('새 웹스토어 주소에서 뽑는다', () => {
    expect(
      extractExtensionId(
        'https://chromewebstore.google.com/detail/ublock/cjpalhdlnbpafiamejdnhcphjbkeiagm'
      )
    ).toBe('cjpalhdlnbpafiamejdnhcphjbkeiagm')
  })

  it('옛 주소와 쿼리 문자열도 처리한다', () => {
    expect(
      extractExtensionId(
        'https://chrome.google.com/webstore/detail/ublock/cjpalhdlnbpafiamejdnhcphjbkeiagm?hl=ko'
      )
    ).toBe('cjpalhdlnbpafiamejdnhcphjbkeiagm')
  })

  it('32자 id 만 넣어도 된다', () => {
    expect(extractExtensionId('  cjpalhdlnbpafiamejdnhcphjbkeiagm ')).toBe(
      'cjpalhdlnbpafiamejdnhcphjbkeiagm'
    )
  })

  it('id 가 없으면 거부한다', () => {
    expect(() => extractExtensionId('https://example.com/hello')).toThrow()
    expect(() => extractExtensionId('')).toThrow()
    // a–p 를 벗어난 글자는 확장 id 가 아니다
    expect(() => extractExtensionId('z'.repeat(32))).toThrow()
  })
})

describe('CRX 내려받기 주소', () => {
  it('id·프로덕트 버전·acceptformat 을 담는다', () => {
    const url = buildCrxUrl('cjpalhdlnbpafiamejdnhcphjbkeiagm', '140.0.0.0')
    expect(url).toContain('acceptformat=crx3')
    expect(url).toContain('prodversion=140.0.0.0')
    expect(url).toContain('x=id%3Dcjpalhdlnbpafiamejdnhcphjbkeiagm%26uc')
  })
})

describe('CRX3 헤더 파싱', () => {
  const zip = makeZip([{ name: 'manifest.json', data: '{"manifest_version":3}' }])

  it('헤더를 걷어 내고 ZIP 부분만 돌려준다', () => {
    const out = parseCrx3(makeCrx(zip))
    expect(out.subarray(0, 2).toString('latin1')).toBe('PK')
    expect(out.equals(zip)).toBe(true)
  })

  it('매직 넘버가 다르면 거부한다', () => {
    const bad = makeCrx(zip)
    bad.write('XX24', 0, 'latin1')
    expect(() => parseCrx3(bad)).toThrow(/CRX 파일이 아니에요/)
  })

  it('CRX2 는 거부한다', () => {
    expect(() => parseCrx3(makeCrx(zip, 2))).toThrow(/CRX 버전/)
  })

  it('헤더 길이가 파일보다 크면 거부한다', () => {
    const bad = makeCrx(zip)
    bad.writeUInt32LE(0xffff, 8)
    expect(() => parseCrx3(bad)).toThrow(/헤더 길이/)
  })

  it('너무 짧은 파일은 거부한다', () => {
    expect(() => parseCrx3(Buffer.from('Cr24'))).toThrow()
  })
})

describe('ZIP 해제와 zip-slip 차단', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'samba-crx-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('평범한 항목은 폴더 안에 쓴다', () => {
    const zip = makeZip([
      { name: 'manifest.json', data: '{"manifest_version":3}' },
      { name: 'js/bg.js', data: 'console.log(1)' }
    ])
    extractZip(zip, dir)
    expect(readFileSync(join(dir, 'js', 'bg.js'), 'utf8')).toBe('console.log(1)')
  })

  it('`..` 로 폴더 밖을 가리키는 항목을 거부한다', () => {
    const zip = makeZip([{ name: '../evil.js', data: 'pwned' }])
    expect(() => extractZip(zip, dir)).toThrow(/확장 폴더 밖/)
    expect(existsSync(join(dir, '..', 'evil.js'))).toBe(false)
  })

  it('경로 이탈 항목이 하나라도 있으면 아무것도 쓰지 않는다', () => {
    const zip = makeZip([
      { name: 'manifest.json', data: '{}' },
      { name: '../../evil.js', data: 'pwned' }
    ])
    expect(() => extractZip(zip, dir)).toThrow()
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false)
  })

  it('절대 경로·드라이브 문자도 거부한다', () => {
    expect(() => safeEntryPath(dir, '/etc/passwd')).toThrow()
    expect(() => safeEntryPath(dir, 'C:/Windows/system32/x.dll')).toThrow()
    expect(() => safeEntryPath(dir, 'a/../../b')).toThrow()
  })

  // 3차 리뷰 I4 — zip bomb 방어. 상한은 기본값(5,000개 / 200MB)이 있고,
  // 테스트는 같은 경로를 작은 값으로 확인한다
  it('기본 상한이 5,000개 / 200MB 다', () => {
    expect(MAX_ZIP_ENTRIES).toBe(5000)
    expect(MAX_UNZIPPED_BYTES).toBe(200 * 1024 * 1024)
  })

  it('항목 수 상한을 넘으면 아무것도 쓰지 않는다', () => {
    const zip = makeZip([
      { name: 'a.txt', data: 'x' },
      { name: 'b.txt', data: 'y' },
      { name: 'c.txt', data: 'z' }
    ])
    expect(() => extractZip(zip, dir, { maxEntries: 2 })).toThrow(/파일이 너무 많아요/)
    expect(existsSync(join(dir, 'a.txt'))).toBe(false)
  })

  it('해제 총량 상한을 넘으면 아무것도 쓰지 않는다', () => {
    const zip = makeZip([
      { name: 'a.txt', data: 'x'.repeat(100) },
      { name: 'b.txt', data: 'y'.repeat(100) }
    ])
    expect(() => extractZip(zip, dir, { maxBytes: 150 })).toThrow(/너무 커져요/)
    expect(existsSync(join(dir, 'a.txt'))).toBe(false)
  })

  it('상한 안이면 그대로 푼다', () => {
    const zip = makeZip([{ name: 'a.txt', data: 'x'.repeat(100) }])
    extractZip(zip, dir, { maxBytes: 150, maxEntries: 5 })
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toHaveLength(100)
  })
})

describe('CRX 내려받기 방어', () => {
  const okResponse = (
    buf: Buffer
  ): {
    ok: boolean
    status: number
    arrayBuffer: () => Promise<ArrayBuffer>
  } => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  })

  it('HTTP 오류를 사유로 바꾼다', async () => {
    await expect(
      downloadCrx('https://x', async () => ({
        ok: false,
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(0)
      }))
    ).rejects.toThrow(/HTTP 404/)
  })

  it('상한을 넘으면 거부한다', async () => {
    await expect(
      downloadCrx('https://x', async () => okResponse(Buffer.alloc(100)), 10)
    ).rejects.toThrow(/너무 커요/)
  })

  it('빈 응답을 거부한다', async () => {
    await expect(downloadCrx('https://x', async () => okResponse(Buffer.alloc(0)))).rejects.toThrow(
      /비어 있어요/
    )
  })

  // 3차 리뷰 I4 — 통째로 메모리에 올린 뒤 재지 않고, 받으면서 끊는다
  describe('스트리밍 상한', () => {
    /** 조각을 흘려 보내며 몇 개까지 읽혔는지 센다 */
    const streamResponse = (
      chunks: Buffer[],
      read: { count: number }
    ): {
      ok: boolean
      status: number
      body: AsyncIterable<Uint8Array>
      arrayBuffer: () => Promise<ArrayBuffer>
    } => ({
      ok: true,
      status: 200,
      body: (async function* () {
        for (const chunk of chunks) {
          read.count += 1
          yield new Uint8Array(chunk)
        }
      })(),
      arrayBuffer: async () => {
        throw new Error('스트림이 있으면 arrayBuffer 를 쓰면 안 된다')
      }
    })

    it('상한을 넘는 순간 더 읽지 않고 끊는다', async () => {
      const read = { count: 0 }
      const chunks = Array.from({ length: 10 }, () => Buffer.alloc(100))
      await expect(
        downloadCrx('https://x', async () => streamResponse(chunks, read), 250)
      ).rejects.toThrow(/너무 커요/)
      // 3조각째에 250 바이트를 넘어 멈춘다 — 10조각을 다 읽지 않는다
      expect(read.count).toBe(3)
    })

    it('상한 안이면 조각을 모두 이어 붙인다', async () => {
      const read = { count: 0 }
      const chunks = [Buffer.from('Cr2'), Buffer.from('4rest')]
      const buf = await downloadCrx('https://x', async () => streamResponse(chunks, read), 1000)
      expect(buf.toString('utf8')).toBe('Cr24rest')
    })
  })
})

describe('웹스토어 설치 전체 흐름(네트워크는 가짜)', () => {
  let root = ''
  const id = DEFAULT_ID
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'samba-ext-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const fetcherFor = (crx: Buffer) => async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => crx.buffer.slice(crx.byteOffset, crx.byteOffset + crx.byteLength)
  })

  it('MV3 확장을 <root>/<id> 에 해제한다', async () => {
    const zip = makeZip([
      { name: 'manifest.json', data: '{"name":"a","version":"1.0","manifest_version":3}' }
    ])
    const dest = await installFromWebstore(id, {
      destRoot: root,
      chromiumVersion: '140.0.0.0',
      fetchImpl: fetcherFor(makeCrx(zip))
    })
    expect(dest).toBe(join(root, id))
    expect(existsSync(join(dest, 'manifest.json'))).toBe(true)
  })

  it('MV2 는 사유를 남기고 폴더를 지운다', async () => {
    const zip = makeZip([
      { name: 'manifest.json', data: '{"name":"a","version":"1.0","manifest_version":2}' }
    ])
    await expect(
      installFromWebstore(id, {
        destRoot: root,
        chromiumVersion: '140.0.0.0',
        fetchImpl: fetcherFor(makeCrx(zip))
      })
    ).rejects.toThrow(/MV2/)
    expect(existsSync(join(root, id))).toBe(false)
  })

  it('manifest.json 이 없으면 거부한다', async () => {
    const zip = makeZip([{ name: 'readme.txt', data: 'hi' }])
    await expect(
      installFromWebstore(id, {
        destRoot: root,
        chromiumVersion: '140.0.0.0',
        fetchImpl: fetcherFor(makeCrx(zip))
      })
    ).rejects.toThrow(/manifest.json/)
    expect(existsSync(join(root, id))).toBe(false)
  })
})

// --- I9 CRX 최종 호스트·crx_id 대조 --------------------------------------------

describe('isAllowedCrxUrl — 리다이렉트 최종 주소', () => {
  it('구글 배포망 호스트는 허용한다', () => {
    expect(isAllowedCrxUrl('https://clients2.google.com/service/update2/crx')).toBe(true)
    expect(isAllowedCrxUrl('https://clients2.googleusercontent.com/crx/blobs/abc.crx')).toBe(true)
    expect(isAllowedCrxUrl('https://edgedl.me.gvt1.com/edgedl/release2/x.crx')).toBe(true)
  })

  it('다른 호스트·http 는 막는다', () => {
    expect(isAllowedCrxUrl('https://evil.example.com/x.crx')).toBe(false)
    expect(isAllowedCrxUrl('https://notgoogle.com.evil.net/x.crx')).toBe(false)
    expect(isAllowedCrxUrl('http://clients2.google.com/x.crx')).toBe(false)
    expect(isAllowedCrxUrl('주소가 아님')).toBe(false)
  })
})

describe('parseCrxId — 헤더에 적힌 확장 id', () => {
  const zip = makeZip([{ name: 'manifest.json', data: '{"manifest_version":3}' }])

  it('CRX3 헤더에서 id 를 읽는다', () => {
    expect(parseCrxId(makeCrx(zip))).toBe(DEFAULT_ID)
  })

  it('헤더에 서명 데이터가 없으면 null', () => {
    expect(parseCrxId(makeCrx(zip, 3, Buffer.from('fake-crx3-header')))).toBeNull()
  })
})

describe('설치 — 받은 파일이 요청한 확장인지 확인한다', () => {
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'samba-ext-id-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const fetcherFor = (crx: Buffer) => async () => ({
    ok: true,
    status: 200,
    url: 'https://clients2.googleusercontent.com/crx/blobs/x.crx',
    arrayBuffer: async () => crx.buffer.slice(crx.byteOffset, crx.byteOffset + crx.byteLength)
  })

  const zip = makeZip([
    { name: 'manifest.json', data: '{"name":"a","version":"1.0","manifest_version":3}' }
  ])

  it('crx_id 가 다르면 거부하고 폴더도 만들지 않는다', async () => {
    const other = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    await expect(
      installFromWebstore(DEFAULT_ID, {
        destRoot: root,
        chromiumVersion: '140.0.0.0',
        fetchImpl: fetcherFor(makeCrx(zip, 3, crxHeaderFor(other)))
      })
    ).rejects.toThrow(/다른 파일이에요/)
    expect(existsSync(join(root, DEFAULT_ID))).toBe(false)
  })

  it('최종 주소가 구글 호스트가 아니면 받지 않는다', async () => {
    const crx = makeCrx(zip)
    await expect(
      installFromWebstore(DEFAULT_ID, {
        destRoot: root,
        chromiumVersion: '140.0.0.0',
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          url: 'https://evil.example.com/x.crx',
          arrayBuffer: async () => crx.buffer.slice(crx.byteOffset, crx.byteOffset + crx.byteLength)
        })
      })
    ).rejects.toThrow(/허용하지 않는 주소/)
  })

  it('I19 — 폴더를 지우기 전에 호출부가 먼저 걷어낸다', async () => {
    const order: string[] = []
    await installFromWebstore(DEFAULT_ID, {
      destRoot: root,
      chromiumVersion: '140.0.0.0',
      fetchImpl: fetcherFor(makeCrx(zip)),
      onBeforeReplace: (dest) => {
        order.push('removed')
        expect(existsSync(join(dest, 'manifest.json'))).toBe(false)
      }
    })
    order.push('installed')
    expect(order).toEqual(['removed', 'installed'])
  })
})
