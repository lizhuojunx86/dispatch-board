// Pure logic: option parsing, snapshot normalization and the view model.
// Nothing here touches `$`, so every function is testable by value.

import type { PluginOptions } from 'claude-code'

import type { Board, Bucket, Capacity, Lane, Order, Snapshot } from '../types'

export const PANE = 'dispatch-board'

export const EMPTY_BOARD: Board = { snap: null, at: 0, now: 0, error: null, fp: '' }
// Change the tag when Board's fields change: a value an earlier version of
// the mod stored outlives a reload, and a new tag reads it as EMPTY_BOARD.
export const BOARD_SHAPE = 'board-1'

export const ACTIVE_STATES: readonly string[] = ['queued', 'running', 'reviewing']
export const ATTENTION_STATES: readonly string[] = [
  'needs_review',
  'check_failed',
  'timeout',
  'conflict',
  'worker_failed',
  'no_changes',
  'budget_exceeded',
  'runner_error',
]
export const DONE_STATES: readonly string[] = ['accepted', 'rejected', 'cancelled', 'done']

// States that mean something broke, as opposed to "your turn".
const ERROR_STATES: readonly string[] = [
  'check_failed',
  'timeout',
  'conflict',
  'worker_failed',
  'budget_exceeded',
  'runner_error',
]

const DAY_MS = 24 * 60 * 60 * 1000
// A running order with no sign of life for this long is flagged idle.
export const IDLE_AFTER_MS = 20 * 60 * 1000
// Hard caps on what a snapshot keeps, whatever the source prints.
const MAX_OPEN_ORDERS = 200
const MAX_DONE_ORDERS = 200
const MAX_LANES = 50

export type Lang = 'en' | 'zh'

export type Config = {
  /** The data command as an argument vector; empty for the built-in reader. */
  argv: string[]
  /** Identifies the data source, so sessions only share like with like. */
  source: string
  intervalMs: number
  idleMs: number
  showTitles: boolean
  maxRows: number
  demo: boolean
  lang: Lang
}

/** An error whose message is safe to draw: written here, never passed through. */
export class BoardError extends Error {}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Strips control characters and cuts to `max` code points. */
export function clip(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  const points = Array.from(clean)

  return points.length <= max ? clean : `${points.slice(0, max - 1).join('')}…`
}

/** The last path segment: a project is shown by directory name only. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(part => part !== '')

  return parts[parts.length - 1] ?? ''
}

/** Epoch milliseconds from a number or an ISO 8601 string; naive strings are UTC. */
export function toMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const text = value.trim()
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text)
  const ms = Date.parse(hasZone ? text : `${text}Z`)

  return Number.isFinite(ms) ? ms : null
}

/** Splits a command line into arguments. No shell: quotes group, nothing expands. */
export function splitArgv(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote = ''
  let isOpen = false
  for (const ch of command) {
    if (quote !== '') {
      if (ch === quote) quote = ''
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      isOpen = true
    } else if (/\s/.test(ch)) {
      if (isOpen || current !== '') out.push(current)
      current = ''
      isOpen = false
    } else {
      current += ch
    }
  }
  if (isOpen || current !== '') out.push(current)

  return out
}

export function readConfig(options: PluginOptions): Config {
  const command = typeof options.command === 'string' ? options.command.trim() : ''
  const seconds = finite(options.intervalSeconds) ?? 10
  const intervalMs = Math.min(3600, Math.max(2, seconds)) * 1000
  const rows = finite(options.maxRows) ?? 6

  return {
    argv: splitArgv(command),
    source: command === '' ? 'agent-dispatch:files' : `command:${command}`,
    intervalMs,
    idleMs: Math.max(60_000, intervalMs),
    showTitles: options.showTitles === true,
    maxRows: Math.min(30, Math.max(1, Math.floor(rows))),
    demo: options.demo === true,
    lang: options.language === 'zh' ? 'zh' : 'en',
  }
}

export function bucketOf(order: Order): Bucket {
  if (order.bucket) return order.bucket
  if (ACTIVE_STATES.includes(order.state)) return 'active'
  if (DONE_STATES.includes(order.state)) return 'done'

  // An unknown state is shown, not hidden: it lands with the ones that need a look.
  return 'attention'
}

function normalizeOrder(raw: unknown, showTitles: boolean): Order | null {
  if (!isRecord(raw)) return null
  const id = clip(raw.id, 64)
  const state = clip(raw.state, 24)
  if (id === '' || state === '') return null
  const order: Order = {
    id,
    project: clip(basename(clip(raw.project, 400)), 40),
    lane: clip(raw.lane, 24),
    state,
    round: Math.max(1, Math.floor(finite(raw.round) ?? 1)),
    startedAt: toMs(raw.startedAt),
    updatedAt: toMs(raw.updatedAt),
  }
  if (raw.bucket === 'active' || raw.bucket === 'attention' || raw.bucket === 'done') {
    order.bucket = raw.bucket
  }
  if (showTitles) {
    const title = clip(raw.title, 40)
    if (title !== '') order.title = title
  }

  return order
}

function normalizeLane(raw: unknown): Lane | null {
  if (!isRecord(raw)) return null
  const name = clip(raw.name, 24)
  if (name === '') return null

  return {
    name,
    costMonth: Math.max(0, finite(raw.costMonth) ?? 0),
    budgetMonth: Math.max(0, finite(raw.budgetMonth) ?? 0),
  }
}

function normalizeCapacity(raw: unknown): Capacity | null {
  if (!isRecord(raw)) return null
  const running = finite(raw.running)
  if (running === null) return null
  const max = finite(raw.max)

  return { running: Math.max(0, Math.floor(running)), max: max !== null && max > 0 ? Math.floor(max) : null }
}

/**
 * Reduces anything shaped like a board snapshot to exactly the contract:
 * unknown fields dropped, strings cut, projects reduced to a directory name,
 * titles kept only when asked for, history trimmed to the last day.
 */
export function normalize(raw: unknown, now: number, showTitles: boolean): Snapshot {
  if (!isRecord(raw) || !Array.isArray(raw.orders)) {
    throw new BoardError('output is not a board snapshot')
  }
  const open: Order[] = []
  const done: Order[] = []
  for (const item of raw.orders) {
    const order = normalizeOrder(item, showTitles)
    if (!order) continue
    if (bucketOf(order) !== 'done') open.push(order)
    // A finished order with no time cannot be placed in the last day: left out.
    else if (order.updatedAt !== null && now - order.updatedAt < DAY_MS) done.push(order)
  }
  done.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const lanes: Lane[] = []
  for (const item of Array.isArray(raw.lanes) ? raw.lanes : []) {
    const lane = normalizeLane(item)
    if (lane) lanes.push(lane)
  }

  return {
    orders: [...open.slice(0, MAX_OPEN_ORDERS), ...done.slice(0, MAX_DONE_ORDERS)],
    lanes: lanes.slice(0, MAX_LANES),
    capacity: normalizeCapacity(raw.capacity),
  }
}

/** A failure's first line, cut short, with any absolute path reduced to its last segment. */
export function reasonLine(text: unknown): string {
  const first = String(text ?? '').split(/\r?\n/).find(line => line.trim() !== '') ?? ''
  const noPaths = first.replace(/(?:~|\.{0,2})?(?:\/[^\s/'":]+){2,}/g, path => `…/${basename(path)}`)

  return clip(noPaths, 60)
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export type Tone = 'normal' | 'dim' | 'warning' | 'error'

export type RowView = {
  id: string
  /** Project and lane, already joined. */
  where: string
  state: string
  tone: Tone
  /** Round, age and any idle marker, already joined. */
  tail: string
  title: string
}

export type LaneView = { name: string; text: string; tone: Tone }

export type View = {
  hasData: boolean
  header: string
  /** The clock time in the header, kept apart so it never forces a redraw. */
  at: number
  stale: string
  attention: RowView[]
  attentionTotal: number
  active: RowView[]
  activeTotal: number
  lanes: LaneView[]
  lanesTotal: number
  done: number
}

const TEXT = {
  en: {
    inFlight: 'In flight',
    queued: 'queued',
    needsYou: 'needs you',
    updated: 'updated',
    loading: 'Reading the board…',
    empty: 'No open work orders.',
    staleNever: (why: string) => `no data yet: ${why}`,
    stale: (seconds: number, why: string) => `data is ${seconds}s old: ${why}`,
    attention: 'Needs you',
    active: 'In flight',
    lanes: 'Lane budget, this month',
    more: (n: number) => `+${n} more`,
    done: (n: number) => `Finished in the last 24h: ${n}`,
    round: (n: number) => `r${n}`,
    idle: (age: string) => `idle ${age}`,
    noCap: 'no cap',
  },
  zh: {
    inFlight: '在途',
    queued: '排队',
    needsYou: '待处理',
    updated: '更新于',
    loading: '正在读取看板…',
    empty: '没有未完成的工作单。',
    staleNever: (why: string) => `尚无数据：${why}`,
    stale: (seconds: number, why: string) => `数据过期 ${seconds} 秒：${why}`,
    attention: '待我处理',
    active: '在途',
    lanes: '通道预算（本月）',
    more: (n: number) => `还有 ${n} 条`,
    done: (n: number) => `近 24 小时完成：${n}`,
    round: (n: number) => `第${n}轮`,
    idle: (age: string) => `无动静 ${age}`,
    noCap: '不限',
  },
} as const

export function labels(lang: Lang) {
  return TEXT[lang]
}

/** A duration at minute granularity, so a redraw is due at most once a minute. */
export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`

  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

export function formatClock(ms: number): string {
  const date = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')

  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

function money(value: number): string {
  return `$${value.toFixed(2)}`
}

function rowView(order: Order, now: number, bucket: Bucket, config: Config): RowView {
  const t = labels(config.lang)
  const since = bucket === 'active' ? order.startedAt : (order.updatedAt ?? order.startedAt)
  const parts = [t.round(order.round)]
  if (since !== null) parts.push(formatAge(now - since))
  let tone: Tone = 'normal'
  if (bucket === 'attention') tone = ERROR_STATES.includes(order.state) ? 'error' : 'warning'
  else if (order.state === 'queued') tone = 'dim'
  const isRunning = bucket === 'active' && order.state !== 'queued'
  if (isRunning && order.updatedAt !== null && now - order.updatedAt >= IDLE_AFTER_MS) {
    parts.push(t.idle(formatAge(now - order.updatedAt)))
    tone = 'warning'
  }

  return {
    id: order.id,
    where: [order.project, order.lane].filter(part => part !== '').join(' · '),
    state: order.state,
    tone,
    tail: parts.join(' · '),
    title: config.showTitles ? (order.title ?? '') : '',
  }
}

function laneView(lane: Lane, config: Config): LaneView {
  if (lane.budgetMonth <= 0) {
    return {
      name: lane.name,
      text: `${money(lane.costMonth)} / ${labels(config.lang).noCap}`,
      tone: 'normal',
    }
  }
  const share = lane.costMonth / lane.budgetMonth
  const tone: Tone = share >= 1 ? 'error' : share >= 0.8 ? 'warning' : 'normal'

  return {
    name: lane.name,
    text: `${money(lane.costMonth)} / ${money(lane.budgetMonth)} · ${Math.floor(share * 100)}%`,
    tone,
  }
}

function laneWeight(lane: Lane): number {
  return lane.budgetMonth > 0 ? lane.costMonth / lane.budgetMonth : -1
}

/**
 * Everything the pane draws, as plain data. Its size depends on `maxRows`
 * alone: history is a count, and each list is cut with the rest counted.
 */
export function buildView(board: Pick<Board, 'snap' | 'at' | 'now' | 'error'>, config: Config): View {
  const t = labels(config.lang)
  const { snap, now } = board
  let stale = ''
  if (board.error !== null) {
    stale = snap
      ? t.stale(Math.max(0, Math.round((now - board.at) / 1000)), board.error)
      : t.staleNever(board.error)
  }
  if (!snap) {
    return {
      hasData: false,
      header: t.loading,
      at: 0,
      stale,
      attention: [],
      attentionTotal: 0,
      active: [],
      activeTotal: 0,
      lanes: [],
      lanesTotal: 0,
      done: 0,
    }
  }
  const attention: Order[] = []
  const active: Order[] = []
  let done = 0
  for (const order of snap.orders) {
    const bucket = bucketOf(order)
    if (bucket === 'attention') attention.push(order)
    else if (bucket === 'active') active.push(order)
    else done += 1
  }
  attention.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  // Running before queued, then the longest-running first.
  const rank = (order: Order) => (order.state === 'queued' ? 1 : 0)
  active.sort((a, b) => rank(a) - rank(b) || (a.startedAt ?? 0) - (b.startedAt ?? 0))
  const queued = active.filter(order => order.state === 'queued').length
  const running = snap.capacity ? snap.capacity.running : active.length - queued
  const max = snap.capacity?.max ?? null
  const header = [`${t.inFlight} ${running}${max !== null ? `/${max}` : ''}`]
  if (queued > 0) header.push(`${t.queued} ${queued}`)
  header.push(`${t.needsYou} ${attention.length}`)
  // A lane is worth a row once it has spent something or has work on it.
  const lanes = snap.lanes
    .filter(lane => lane.costMonth > 0 || active.some(order => order.lane === lane.name))
    .sort((a, b) => laneWeight(b) - laneWeight(a) || b.costMonth - a.costMonth)

  return {
    hasData: true,
    header: header.join(' · '),
    at: board.at,
    stale,
    attention: attention.slice(0, config.maxRows).map(o => rowView(o, now, 'attention', config)),
    attentionTotal: attention.length,
    active: active.slice(0, config.maxRows).map(o => rowView(o, now, 'active', config)),
    activeTotal: active.length,
    lanes: lanes.slice(0, config.maxRows).map(lane => laneView(lane, config)),
    lanesTotal: lanes.length,
    done,
  }
}

/** Identifies what is drawn, apart from the header's clock time. */
export function fingerprint(view: View): string {
  return JSON.stringify({ ...view, at: 0 })
}

export function activeCount(snap: Snapshot | null): number {
  return snap ? snap.orders.filter(order => bucketOf(order) === 'active').length : 0
}

// ---------------------------------------------------------------------------
// Fitting text to the pane
// ---------------------------------------------------------------------------

function isWide(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd))
  )
}

/** Terminal cells a string takes: CJK and emoji count two. */
export function cells(text: string): number {
  let total = 0
  for (const ch of text) total += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1

  return total
}

/** Cuts `text` to at most `max` cells, ending in an ellipsis when cut. */
export function fit(text: string, max: number): string {
  if (cells(text) <= max) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
    if (used + w > max - 1) break
    out += ch
    used += w
  }

  return `${out}…`
}
