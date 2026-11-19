// Adapter for agent-dispatch, a file-based work-order dispatcher: maps its
// data to the normalized board snapshot. Read it as a worked example when
// writing an adapter for another orchestrator.
//
// Two entry points:
//
// - `readHome` reads the orchestrator's state files directly. This is the
//   default source, because `agent-dispatch status` is not read-only: both
//   its single-order and its list form reconcile dead runners, which writes
//   state.json and can signal process groups. A board that polls every ten
//   seconds must never do that. State files are written with a temp file and
//   an atomic rename, so a read sees a whole old file or a whole new one.
// - `fromStatusRows` maps the JSON rows of `agent-dispatch status --json`,
//   for a build of agent-dispatch whose status can be told not to reconcile.

import type { EngineInterface } from 'claude-code'

import { BoardError, DONE_STATES, basename, isRecord, toMs } from '../hooks/model'

type Engine = Pick<EngineInterface, 'fs' | 'env'>

/** One attempt's spend: which lane, which UTC month, how much. */
type Spend = { lane: string; month: string; cost: number }

/** An order as the adapter remembers it between polls. */
type Row = {
  id: string
  project: string
  lane: string
  state: string
  round: number
  startedAt: unknown
  updatedAt: unknown
  title: string
  holdsSlot: boolean
  spend: Spend[]
}

type Limits = { max: number | null; budgets: Record<string, number>; readAt: number }

/** What a session remembers of the orders tree, so a poll reads only what can change. */
export type HomeCache = {
  home: string
  /** Orders in a state nothing leaves: read once, then never again. */
  finals: Map<string, { finishedAt: number | null; spend: Spend[] }>
  /** From meta.json: project and title never change, and state's lane wins over meta's. */
  metas: Map<string, { project: string; lane: string; title: string }>
  /** The last good read of every open order, kept across an unreadable file. */
  rows: Map<string, Row>
  limits: Limits | null
}

export function newHomeCache(): HomeCache {
  return { home: '', finals: new Map(), metas: new Map(), rows: new Map(), limits: null }
}

const BATCH = 24
const LIMITS_TTL_MS = 60_000
const DEFAULT_MAX_PARALLEL = 3
const ACTIVITY_FILE = /^(?:events-\d+\.jsonl|review-events-\d+\.jsonl|runner\.log|state\.json|runner\.heartbeat)$/

function utcMonth(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

async function readJson($: Engine, path: string): Promise<unknown> {
  // A missing, unreadable or half-written file all read as "no value".
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return undefined
  }
}

async function inBatches<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += BATCH) {
    await Promise.all(items.slice(i, i + BATCH).map(work))
  }
}

function spendOf(state: Record<string, unknown>): Spend[] {
  const out: Spend[] = []
  for (const attempt of Array.isArray(state.attempts) ? state.attempts : []) {
    if (!isRecord(attempt)) continue
    const lane = text(attempt.worker)
    const started = toMs(attempt.started_at)
    if (lane === '' || started === null) continue
    const cost = typeof attempt.cost === 'number' && Number.isFinite(attempt.cost) ? attempt.cost : 0
    out.push({ lane, month: utcMonth(started), cost })
  }

  return out
}

async function resolveHome($: Engine): Promise<string> {
  const explicit = await $.env.get('AGENT_DISPATCH_HOME')
  if (explicit) return explicit.replace(/\/+$/, '')
  const home = await $.env.get('HOME')
  if (!home) throw new BoardError('cannot locate the agent-dispatch home')

  return `${home.replace(/\/+$/, '')}/.agent-dispatch`
}

/** The global slot cap and each lane's monthly budget: the only config values read. */
async function readLimits($: Engine, cache: HomeCache, now: number): Promise<Limits> {
  if (cache.limits && now - cache.limits.readAt < LIMITS_TTL_MS) return cache.limits
  const config = await readJson($, `${cache.home}/config.json`)
  const limits: Limits = { max: DEFAULT_MAX_PARALLEL, budgets: {}, readAt: now }
  if (isRecord(config)) {
    const max = config.max_parallel
    if (typeof max === 'number' && Number.isFinite(max) && max >= 1) limits.max = Math.floor(max)
    for (const [name, worker] of Object.entries(isRecord(config.workers) ? config.workers : {})) {
      const budget = isRecord(worker) ? worker.budget_usd_month : undefined
      if (typeof budget === 'number' && Number.isFinite(budget) && budget >= 0) {
        limits.budgets[name] = budget
      }
    }
  } else if (cache.limits) {
    // Unreadable this round: keep what the last good read said.
    return { ...cache.limits, readAt: now }
  }
  cache.limits = limits

  return limits
}

async function lastActivity($: Engine, dir: string): Promise<number | null> {
  try {
    let newest = 0
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind === 'file' && ACTIVITY_FILE.test(entry.name)) {
        newest = Math.max(newest, entry.mtimeMs)
      }
    }

    return newest > 0 ? newest : null
  } catch {
    return null
  }
}

async function readOrder($: Engine, cache: HomeCache, id: string): Promise<void> {
  const dir = `${cache.home}/orders/${id}`
  const state = await readJson($, `${dir}/state.json`)
  // Unreadable this round: whatever the last good read said stands.
  if (!isRecord(state)) return
  const name = text(state.state) || 'queued'
  const spend = spendOf(state)
  if (DONE_STATES.includes(name)) {
    cache.rows.delete(id)
    cache.finals.set(id, { finishedAt: toMs(state.finished_at), spend })

    return
  }
  let meta = cache.metas.get(id)
  if (!meta) {
    const raw = await readJson($, `${dir}/meta.json`)
    // No readable meta.json: not an order yet (or not one at all).
    if (!isRecord(raw)) return
    meta = {
      project: basename(text(raw.project)),
      lane: text(raw.worker),
      title: text(raw.title),
    }
    cache.metas.set(id, meta)
  }
  const isRunning = name === 'running' || name === 'reviewing'
  const isQueued = name === 'queued'
  const startedAt = isQueued ? (state.queued_at ?? state.started_at) : state.started_at
  cache.rows.set(id, {
    id,
    project: meta.project,
    lane: text(state.current_worker) || meta.lane,
    state: name,
    round: typeof state.attempt === 'number' ? state.attempt : 1,
    startedAt,
    // A queued order has not moved since it was queued, which is what the dispatcher reports too.
    updatedAt: isRunning
      ? ((await lastActivity($, dir)) ?? state.started_at)
      : isQueued
        ? startedAt
        : (state.finished_at ?? state.started_at),
    title: meta.title,
    holdsSlot: name === 'running' || (name === 'reviewing' && text(state.slot_worker) !== ''),
    spend,
  })
}

/**
 * Reads the orders tree and returns a raw snapshot for `normalize`.
 *
 * The first call reads every order's state.json once. Later calls list the
 * orders directory and read only orders that are still open, so the cost of a
 * poll follows the open orders, not the history.
 */
export async function readHome($: Engine, cache: HomeCache, now: number): Promise<unknown> {
  const home = await resolveHome($)
  if (cache.home !== home) {
    cache.home = home
    cache.finals.clear()
    cache.metas.clear()
    cache.rows.clear()
    cache.limits = null
  }
  let names: string[]
  try {
    names = (await $.fs.list(`${home}/orders`))
      .filter(entry => entry.kind === 'dir')
      .map(entry => entry.name)
  } catch {
    throw new BoardError('no agent-dispatch orders directory')
  }
  const present = new Set(names)
  for (const id of [...cache.rows.keys()]) if (!present.has(id)) cache.rows.delete(id)
  for (const id of [...cache.finals.keys()]) if (!present.has(id)) cache.finals.delete(id)
  await inBatches(
    names.filter(id => !cache.finals.has(id)),
    id => readOrder($, cache, id),
  )
  const limits = await readLimits($, cache, now)

  const month = utcMonth(now)
  const spent: Record<string, number> = {}
  const add = (spend: Spend[]) => {
    for (const one of spend) {
      if (one.month === month) spent[one.lane] = (spent[one.lane] ?? 0) + one.cost
    }
  }
  const orders: unknown[] = []
  let running = 0
  for (const row of cache.rows.values()) {
    add(row.spend)
    if (row.holdsSlot) running += 1
    const { holdsSlot: _holdsSlot, spend: _spend, ...order } = row
    orders.push(order)
  }
  for (const [id, final] of cache.finals) {
    add(final.spend)
    // History reaches the board as a count: only the last day's orders go on.
    if (final.finishedAt !== null && now - final.finishedAt < 24 * 60 * 60 * 1000) {
      orders.push({ id, state: 'done', updatedAt: final.finishedAt })
    }
  }
  const lanes = [...new Set([...Object.keys(spent), ...Object.keys(limits.budgets)])].map(name => ({
    name,
    costMonth: spent[name] ?? 0,
    budgetMonth: limits.budgets[name] ?? 0,
  }))

  return { orders, lanes, capacity: { running, max: limits.max } }
}

function durationMs(value: unknown): number | null {
  // `status` prints a duration as "42s" or "17m5s".
  const match = /^(?:(\d+)m)?(\d+)s$/.exec(text(value))

  return match ? (Number(match[1] ?? 0) * 60 + Number(match[2])) * 1000 : null
}

function idTimeMs(id: string): number | null {
  // An order id opens with its local creation time: YYYYMMDD-HHMMSS-slug.
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-|$)/.exec(id)
  if (!m) return null
  const part = (i: number) => Number(m[i] ?? 0)

  return new Date(part(1), part(2) - 1, part(3), part(4), part(5), part(6)).getTime()
}

/** True for what `agent-dispatch status --json` prints in its list form. */
export function isStatusRows(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/**
 * Maps `agent-dispatch status --json` rows to a raw snapshot for `normalize`.
 *
 * The rows carry no timestamps, lane budgets or slot cap: start times are
 * worked out from the printed duration, and lanes and the cap stay unknown.
 */
export function fromStatusRows(rows: readonly unknown[], now: number): unknown {
  const orders: unknown[] = []
  let running = 0
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = text(row.id)
    const state = text(row.state)
    const isRunning = state === 'running' || state === 'reviewing'
    if (isRunning) running += 1
    const duration = durationMs(row.duration)
    const created = idTimeMs(id)
    const idleS = typeof row.last_event_age_s === 'number' ? row.last_event_age_s : null
    let startedAt: number | null = created
    let updatedAt: number | null = created !== null && duration !== null ? created + duration : created
    if (isRunning) {
      startedAt = duration !== null ? now - duration : created
      updatedAt = idleS !== null ? now - idleS * 1000 : now
    }
    orders.push({
      id,
      project: text(row.project),
      lane: text(row.current_worker) || text(row.worker),
      state,
      round: typeof row.attempt === 'number' ? row.attempt : 1,
      startedAt,
      updatedAt,
      title: text(row.title),
    })
  }

  return { orders, lanes: [], capacity: { running, max: null } }
}
