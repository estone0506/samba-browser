// 미리 띄워 두는 예비 CLI 프로세스 풀.
//
// 왜 필요한가:
// Claude Agent SDK 호출 한 번은 "CLI 하위 프로세스 spawn + 초기화 + 응답 대기" 다.
// 번역처럼 짧은 호출을 여러 번 하면 spawn 시간이 매번 그대로 얹힌다. SDK 의 startup()
// 으로 프로세스를 미리 띄워 두면(초기화까지 끝난 상태) 실제 호출은 프롬프트만 써 넣는다.
//
// 이 파일에는 SDK 도 인증도 없다 — "예비를 몇 개 들고 있다가 하나씩 내준다" 는
// 순수한 살림살이만 담아 단위 테스트로 확인한다(실제 spawn 은 provider.ts 가 한다).

export interface WarmPoolDeps<T> {
  /** 쓰지 않고 버릴 때 호출한다(프로세스 정리) */
  close: (spare: T) => void
  /** 동시에 준비해 둘 예비 수 */
  size: number
  /** 이 시간 동안 아무도 안 가져가면 닫는다(기본 5분) */
  idleMs?: number
  /** 타이머(테스트에서 가짜를 주입한다) */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
}

interface Spare<T> {
  value: T
  timer: unknown
}

const DEFAULT_IDLE_MS = 5 * 60_000

export class WarmPool<T> {
  private spares: Spare<T>[] = []
  // 지금 띄우는 중인 개수(중복으로 우르르 띄우지 않기 위한 셈)
  private starting = 0
  // 예비가 어떤 설정으로 떠 있는지(모델·시스템 프롬프트가 바뀌면 기존 예비는 못 쓴다)
  private key = ''
  private disposed = false

  constructor(private readonly deps: WarmPoolDeps<T>) {}

  private get idleMs(): number {
    return this.deps.idleMs ?? DEFAULT_IDLE_MS
  }

  private setTimer(fn: () => void, ms: number): unknown {
    if (this.deps.setTimer) return this.deps.setTimer(fn, ms)
    const id = setTimeout(fn, ms)
    id.unref?.()
    return id
  }

  private clearTimer(id: unknown): void {
    if (this.deps.clearTimer) this.deps.clearTimer(id)
    else clearTimeout(id as ReturnType<typeof setTimeout>)
  }

  /** 들고 있던 예비를 전부 닫는다 */
  private dropAll(): void {
    const dropped = this.spares
    this.spares = []
    for (const s of dropped) {
      this.clearTimer(s.timer)
      this.deps.close(s.value)
    }
  }

  /** 설정이 바뀌었으면 들고 있던 예비를 버린다 */
  private useKey(key: string): void {
    if (this.key === key) return
    this.key = key
    this.dropAll()
  }

  /** 준비된 예비 하나를 꺼낸다. 없으면 null(호출부가 평소처럼 새로 띄운다) */
  claim(key: string): T | null {
    if (this.disposed) return null
    this.useKey(key)
    const spare = this.spares.shift()
    if (!spare) return null
    this.clearTimer(spare.timer)
    return spare.value
  }

  /** 모자란 만큼 예비를 띄워 둔다. 기다리지 않는다(다음 호출이 덕을 본다) */
  prewarm(key: string, start: () => Promise<T | null>): void {
    if (this.disposed) return
    this.useKey(key)
    while (this.spares.length + this.starting < Math.max(0, this.deps.size)) {
      this.starting += 1
      void start()
        .then((value) => this.accept(key, value))
        .catch(() => {
          // 예비를 못 띄운 것은 실패가 아니다 — 그냥 평소 경로로 돈다
          this.starting -= 1
        })
    }
  }

  /** 다 띄운 예비를 선반에 올린다(그새 설정이 바뀌었거나 정리됐으면 버린다) */
  private accept(key: string, value: T | null): void {
    this.starting -= 1
    if (!value) return
    if (this.disposed || key !== this.key || this.spares.length >= this.deps.size) {
      this.deps.close(value)
      return
    }
    const spare: Spare<T> = { value, timer: null }
    spare.timer = this.setTimer(() => this.expire(spare), this.idleMs)
    this.spares.push(spare)
  }

  /** 오래 안 쓴 예비를 닫는다(놀고 있는 프로세스를 들고 있지 않는다) */
  private expire(spare: Spare<T>): void {
    const index = this.spares.indexOf(spare)
    if (index < 0) return
    this.spares.splice(index, 1)
    this.deps.close(spare.value)
  }

  /** 준비된 예비 수(테스트·진단용) */
  ready(): number {
    return this.spares.length
  }

  dispose(): void {
    this.disposed = true
    this.dropAll()
  }
}
