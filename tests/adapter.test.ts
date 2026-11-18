import { expect, mock, test } from 'claude-code/testing'

import { fromStatusRows } from '../adapters/agent-dispatch'
import { bucketOf, normalize, splitArgv } from '../hooks/model'
import { fakeHome, ROOT } from './fixtures/home'
import { statusRows } from './fixtures/status-rows'
import { NOW, desk, drawnTree, lines, openBoard } from './kit'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

test('status rows map to the normalized snapshot', () => {
  const snap = normalize(fromStatusRows(statusRows, NOW), NOW, false)
  const byState = Object.fromEntries(snap.orders.map(order => [order.state, order]))

  // Every row keeps exactly the contract's fields, and no title unless asked.
  for (const order of snap.orders) {
    expect(Object.keys(order).sort()).toEqual(
      ['id', 'lane', 'project', 'round', 'startedAt', 'state', 'updatedAt'].sort(),
    )
  }
  expect(byState.running).toMatchObject({
    id: '20260105-100000-fixture-order-00',
    project: 'atlas-api',
    lane: 'lane-a',
    round: 1,
    // "12m5s" of duration, and a last event 20 seconds ago.
    startedAt: NOW - (12 * 60 + 5) * 1000,
    updatedAt: NOW - 20_000,
  })
  expect(byState.reviewing?.round).toBe(2)
  expect(snap.capacity).toEqual({ running: 2, max: null })
  expect(snap.lanes).toEqual([])

  const buckets = (name: string) =>
    snap.orders.filter(order => bucketOf(order) === name).map(order => order.state)
  expect(buckets('active')).toEqual(['running', 'reviewing', 'queued'])
  expect(buckets('attention')).toEqual([
    'needs_review',
    'check_failed',
    'timeout',
    'conflict',
    'worker_failed',
  ])
  // The fixture's finished orders are dated 2026-01-05, ten days before NOW:
  // history older than a day is not carried at all.
  expect(buckets('done')).toEqual([])
})

test('titles are carried only when asked for, cut to 40 characters', () => {
  const snap = normalize(fromStatusRows(statusRows, NOW), NOW, true)
  const title = snap.orders[0]?.title ?? ''

  expect(title.startsWith('FIXTURE-TITLE-00')).toBe(true)
  expect(Array.from(title).length).toBe(40)
})

test('a state the board does not know is shown, not hidden', () => {
  const snap = normalize(
    { orders: [{ id: 'a', state: 'paused_by_operator' }, { id: 'b', state: 'parked', bucket: 'done', updatedAt: NOW }] },
    NOW,
    false,
  )

  expect(snap.orders.map(bucketOf)).toEqual(['attention', 'done'])
})

test('a command line splits into arguments without a shell', () => {
  expect(splitArgv('my-tool status --json')).toEqual(['my-tool', 'status', '--json'])
  expect(splitArgv(`python3 "/opt/my tools/board.py" --lane 'a b' ''`)).toEqual([
    'python3',
    '/opt/my tools/board.py',
    '--lane',
    'a b',
    '',
  ])
  // Nothing a shell would act on is special here.
  expect(splitArgv('echo $(whoami); rm -rf ~ | cat')).toEqual([
    'echo',
    '$(whoami);',
    'rm',
    '-rf',
    '~',
    '|',
    'cat',
  ])
})

test('the built-in reader maps a home on disk: orders, slots, lane spend', async ($, on) => {
  mock.clock(on, { now: NOW })
  desk(on)
  fakeHome(on, NOW, [
    { id: '20260115-110000-run-a', state: 'running', lane: 'lane-a', startedAgo: 12 * MINUTE, costs: [1.5] },
    {
      id: '20260115-103000-review-b',
      state: 'reviewing',
      lane: 'lane-b',
      attempt: 2,
      startedAgo: 40 * MINUTE,
      costs: [2, 2.25],
      holdsSlot: true,
    },
    { id: '20260115-115500-queued-c', state: 'queued', lane: 'lane-c', costs: [] },
    { id: '20260115-090000-review-me', state: 'needs_review', lane: 'lane-a', finishedAgo: 2 * HOUR, costs: [3] },
    { id: '20260114-200000-broke', state: 'check_failed', lane: 'lane-b', finishedAgo: 15 * HOUR, costs: [1] },
    { id: '20260115-080000-merged', state: 'accepted', lane: 'lane-a', finishedAgo: 3 * HOUR, costs: [4.75] },
    { id: '20260112-080000-dropped', state: 'rejected', lane: 'lane-c', finishedAgo: 70 * HOUR, costs: [0.4] },
    // Started last month: its spend belongs to December, not to this month.
    { id: '20251220-080000-old', state: 'accepted', lane: 'lane-a', startedAgo: 26 * 24 * HOUR, finishedAgo: 26 * 24 * HOUR - HOUR, costs: [50] },
  ])

  await openBoard($)
  const drawn = lines(await drawnTree($))

  // Two orders hold a slot out of config.json's max_parallel of 4.
  expect(drawn[0]).toContain('In flight 2/4 · queued 1 · needs you 2')
  expect(drawn).toContain('Needs you (2)')
  expect(drawn.some(row => /review-me · atlas-api · lane-a · needs_review · r1 · 2h00m$/.test(row))).toBe(true)
  expect(drawn.some(row => /broke · atlas-api · lane-b · check_failed · r1 · 15h00m$/.test(row))).toBe(true)
  expect(drawn.some(row => /run-a · atlas-api · lane-a · running · r1 · 12m$/.test(row))).toBe(true)
  expect(drawn.some(row => /review-b · atlas-api · lane-b · reviewing · r2 · 40m$/.test(row))).toBe(true)
  // Spend is summed per attempt for this UTC month: 1.5 + 3 + 4.75, and 2 + 2.25 + 1.
  expect(drawn).toContain('lane-b · $5.25 / $5.00 · 105%')
  expect(drawn).toContain('lane-a · $9.25 / $10.00 · 92%')
  expect(drawn).toContain('lane-c · $0.40 / no cap')
  // A lane with a budget and neither spend nor work is not worth a row.
  expect(drawn.some(row => row.includes('lane-idle'))).toBe(false)
  // One order finished in the last day; older history is not on the board.
  expect(drawn).toContain('Finished in the last 24h: 1')
})

test('a later poll reads only what can still change', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  desk(on)
  const finished = Array.from({ length: 40 }, (_, i) => ({
    id: `20260110-0000${String(i).padStart(2, '0')}-finished`,
    state: i % 2 === 0 ? 'accepted' : 'rejected',
    lane: 'lane-a',
    finishedAgo: (30 + i) * HOUR,
  }))
  const home = fakeHome(on, NOW, [
    { id: '20260115-110000-run-a', state: 'running', lane: 'lane-a', startedAgo: 12 * MINUTE },
    { id: '20260115-090000-review-me', state: 'needs_review', lane: 'lane-a', finishedAgo: 2 * HOUR },
    ...finished,
  ])

  await openBoard($)
  // The first poll reads every state.json once: 42 orders.
  expect(home.reads.filter(path => path.endsWith('/state.json')).length).toBe(42)
  // meta.json only for the two open orders: history needs no project or title.
  expect(home.reads.filter(path => path.endsWith('/meta.json')).length).toBe(2)

  home.reads.length = 0
  await clock.advance(10_000)
  expect(home.reads.filter(path => path.endsWith('/state.json')).sort()).toEqual([
    `${ROOT}/orders/20260115-090000-review-me/state.json`,
    `${ROOT}/orders/20260115-110000-run-a/state.json`,
  ])
  expect(home.reads.filter(path => path.endsWith('/meta.json'))).toEqual([])
  // config.json is read at most once a minute.
  expect(home.reads.filter(path => path.endsWith('/config.json'))).toEqual([])
})

test('a half-written state file keeps the last good row', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  desk(on)
  const home = fakeHome(on, NOW, [
    { id: '20260115-110000-run-a', state: 'running', lane: 'lane-a', startedAgo: 12 * MINUTE },
  ])
  const path = `${ROOT}/orders/20260115-110000-run-a/state.json`
  const whole = home.files.get(path) ?? ''

  await openBoard($)
  home.files.set(path, whole.slice(0, whole.length / 2))
  await clock.advance(10_000)

  const drawn = lines(await drawnTree($))
  expect(drawn[0]).toContain('In flight 1/4')
  expect(drawn.some(row => /run-a · atlas-api · lane-a · running/.test(row))).toBe(true)
  // Not a failure of the poll: the rest of the tree was read.
  expect(drawn.some(row => row.includes('old:'))).toBe(false)
})

test('a running order with no sign of life is flagged idle', async ($, on) => {
  mock.clock(on, { now: NOW })
  desk(on)
  fakeHome(on, NOW, [
    { id: '20260115-100000-stuck', state: 'running', lane: 'lane-a', startedAgo: 90 * MINUTE, activeAgo: 45 * MINUTE },
  ])

  await openBoard($)
  const drawn = lines(await drawnTree($))

  expect(drawn.some(row => /stuck · atlas-api · lane-a · running · r1 · 1h30m · idle 45m$/.test(row))).toBe(true)
})
