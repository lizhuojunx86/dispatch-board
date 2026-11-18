import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeHome, SECRET_MARKERS } from './fixtures/home'
import type { PaneTarget } from './kit'
import { NOW, PANE, SURFACES, WIDE, countElements, desk, drawnTree, lines, openBoard, texts } from './kit'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const COMMAND = { options: { command: 'fake-board --json' } }
const SOURCE = 'command:fake-board --json'
const WIDGET: PaneTarget = { ...PANE, props: { ...PANE.props, placement: 'widget' } }

type Output = { exitCode: number; stdout: string; stderr: string }
type Reply = Output | { deny: string }

/** Stands in for `$.process.run`: counts the runs and answers with `reply()`. */
function fakeCommand(on: On, reply: () => Reply) {
  const runs: { argv: readonly string[]; timeoutMs: number | undefined }[] = []
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, timeoutMs: e.init?.timeoutMs })
    const answer = reply()
    if ('deny' in answer) return answer

    return { value: { ...answer, isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return runs
}

const ok = (snapshot: unknown): Reply => ({ exitCode: 0, stdout: JSON.stringify(snapshot), stderr: '' })

/** A snapshot whose ages sit mid-minute, so ten seconds on nothing drawn changes. */
function board(extra: unknown[] = []) {
  return {
    orders: [
      {
        id: 'run-1',
        project: 'atlas-api',
        lane: 'lane-a',
        state: 'running',
        round: 1,
        startedAt: NOW - 12 * MINUTE - 30_000,
        updatedAt: NOW - 30_000,
      },
      {
        id: 'review-1',
        project: 'billing-ui',
        lane: 'lane-b',
        state: 'needs_review',
        round: 2,
        startedAt: NOW - 3 * HOUR,
        updatedAt: NOW - 2 * HOUR - 30_000,
      },
      ...extra,
    ],
    lanes: [{ name: 'lane-a', costMonth: 8.5, budgetMonth: 10 }],
    capacity: { running: 1, max: 4 },
  }
}

const idle = () => ({ ...board(), orders: board().orders.slice(1), capacity: { running: 0, max: 4 } })

const drawn = drawnTree

test('demo data draws the same board on every surface', { options: { demo: true } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  desk(on)
  // Demo mode reads nothing: any fs, process or env call would have no stand-in and fail.
  await openBoard($)

  const seen = new Set<string>()
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const rows = lines(await ui.drawn())
    seen.add(JSON.stringify(rows))
    expect(rows[0]).toMatch(/^In flight 2\/4 · queued 1 · needs you 3 · updated \d\d:\d\d:\d\d$/)
    expect(rows).toContain('Needs you (3)')
    expect(rows).toContain('In flight (3)')
    expect(rows).toContain('gpt-large · $72.60 / $70.00 · 103%')
    expect(rows).toContain('Finished in the last 24h: 7')
    await ui.unmount()
  }
  expect(seen.size).toBe(1)
})

test('lane rows are colored by share of budget: 80% warns, 100% is an error', { options: { demo: true } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  desk(on)
  await openBoard($)

  const ui = await $.ui.mount({ ...WIDE, surface: 'terminal' })
  const colorOf = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.props.color
  expect(await colorOf(/^\$72\.60 \/ \$70\.00 · 103%$/)).toBe('error')
  expect(await colorOf(/^\$12\.90 \/ \$15\.00 · 86%$/)).toBe('warning')
  expect(await colorOf(/^\$6\.10 \/ \$30\.00 · 20%$/)).toBe(undefined)
  // No cap means no percentage and no color, however much was spent.
  expect(await colorOf(/^\$0\.42 \/ no cap$/)).toBe(undefined)
  expect(await colorOf(/^check_failed$/)).toBe('error')
  expect(await colorOf(/^needs_review$/)).toBe('warning')
  await ui.unmount()
})

test('a minimized pane shows the headline alone', { options: { demo: true } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  desk(on)
  await openBoard($)

  const rows = lines(await drawn($, WIDGET))
  expect(rows.length).toBe(1)
  expect(rows[0]).toContain('In flight 2/4')
})

test('labels follow the language option, titles the showTitles option', { options: { demo: true, language: 'zh', showTitles: true } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  desk(on)
  await openBoard($)

  const rows = lines(await drawn($, WIDE))
  expect(rows[0]).toMatch(/^在途 2\/4 · 排队 1 · 待处理 3 · 更新于 \d\d:\d\d:\d\d$/)
  expect(rows).toContain('待我处理 (3)')
  expect(rows).toContain('通道预算（本月）')
  expect(rows).toContain('近 24 小时完成：7')
  expect(rows.some(row => row.endsWith(' · 第1轮 · 12m · Split the auth middleware'))).toBe(true)
  // 40 characters at most, the cut marked.
  expect(rows.some(row => row.endsWith(' · Add retry with backoff to the fetch cli…'))).toBe(true)
})

test('nothing polls until the pane is opened', COMMAND, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  desk(on)
  const runs = fakeCommand(on, () => ok(board()))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(5 * MINUTE)
  expect(runs.length).toBe(0)

  await openBoard($)
  expect(runs.length).toBe(1)
  // The command runs as an argument vector with a five-second limit.
  expect(runs[0]).toEqual({ argv: ['fake-board', '--json'], timeoutMs: 5000 })
})

test('it polls every 10 seconds with work in flight, once a minute without', COMMAND, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  desk(on)
  let reply = () => ok(board())
  const runs = fakeCommand(on, () => reply())

  await openBoard($)
  await clock.advance(60_000)
  expect(runs.length).toBe(7)

  reply = () => ok(idle())
  await clock.advance(10_000)
  expect(runs.length).toBe(8)
  // Nothing in flight any more: the next five ticks fetch nothing.
  await clock.advance(50_000)
  expect(runs.length).toBe(8)
  await clock.advance(10_000)
  expect(runs.length).toBe(9)
})

test('closing the pane stops the polling, a pane behind another tab pauses it', COMMAND, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const room = desk(on)
  const runs = fakeCommand(on, () => ok(board()))

  await openBoard($)
  expect(runs.length).toBe(1)

  room.isShown = false
  await clock.advance(30_000)
  expect(runs.length).toBe(1)
  room.isShown = true
  await clock.advance(10_000)
  expect(runs.length).toBe(2)

  room.isOpen = false
  await clock.advance(5 * MINUTE)
  expect(runs.length).toBe(2)

  await openBoard($)
  expect(runs.length).toBe(3)
  await clock.advance(10_000)
  expect(runs.length).toBe(4)
})

test('a poll that changes nothing redraws nothing', COMMAND, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  desk(on)
  let reply = () => ok(board())
  const runs = fakeCommand(on, () => reply())
  const header = async () => lines(await drawn($))[0]

  await openBoard($)
  const first = await header()

  // Two more polls, same data: the state the pane draws from is not rewritten,
  // so the header still carries the time of the first poll.
  await clock.advance(20_000)
  expect(runs.length).toBe(3)
  expect(await header()).toBe(first)

  // New data is written, and the header's time moves with it.
  reply = () => ok(board([{ id: 'run-2', project: 'docs-site', lane: 'lane-a', state: 'queued', round: 1, startedAt: NOW }]))
  await clock.advance(10_000)
  const after = await header()
  expect(after).not.toBe(first)
  expect(after).toContain('queued 1')
})

test('sessions share a snapshot: a fresh one is used, and no process starts', COMMAND, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const room = desk(on)
  const runs = fakeCommand(on, () => ok(board()))
  // Another session fetched two seconds ago and stored what it got.
  const other = board([{ id: 'from-the-other-session', project: 'docs-site', lane: 'lane-b', state: 'running', round: 1, startedAt: NOW - 90_000 }])
  room.store.set('snapshot', { at: NOW - 2000, source: SOURCE, snap: other })

  await openBoard($)
  expect(runs.length).toBe(0)
  expect(room.storeWrites).toBe(0)
  expect(texts(await drawn($)).join('')).toContain('from-the-other-session')

  // Ten seconds on that snapshot is twelve seconds old: this session fetches
  // and stores, for the others to read in turn.
  await clock.advance(10_000)
  expect(runs.length).toBe(1)
  expect(room.storeWrites).toBe(1)
  expect((room.store.get('snapshot') as { at: number }).at).toBe(NOW + 10_000)

  // The other session fetches again just before this one's next tick.
  room.store.set('snapshot', { at: NOW + 19_000, source: SOURCE, snap: other })
  await clock.advance(10_000)
  expect(runs.length).toBe(1)
})

test('a snapshot stored for another data source is not used', COMMAND, async ($, on) => {
  mock.clock(on, { now: NOW })
  const room = desk(on)
  const runs = fakeCommand(on, () => ok(board()))
  room.store.set('snapshot', { at: NOW - 2000, source: 'command:something-else', snap: board() })

  await openBoard($)
  expect(runs.length).toBe(1)
})

const FAILURES: [string, () => Reply, string][] = [
  ['the command exits non-zero', () => ({ exitCode: 3, stdout: '', stderr: 'boom: cannot open /srv/private/place/orders.db\nsecond line' }), 'fake-board exited 3: boom: cannot open …/orders.db'],
  ['the command times out', () => ({ deny: 'timed out after 5000 ms' }), 'fake-board did not finish in 5s'],
  ['the command cannot start', () => ({ deny: 'ENOENT' }), 'fake-board could not be started'],
  ['the command prints half a JSON document', () => ({ exitCode: 0, stdout: JSON.stringify(board()).slice(0, 80), stderr: '' }), 'fake-board printed invalid JSON'],
  ['the command prints JSON that is no snapshot', () => ({ exitCode: 0, stdout: '{"hello":"world"}', stderr: '' }), 'output is not a board snapshot'],
]

for (const [name, failure, reason] of FAILURES) {
  test(`when ${name}, the pane says its data is stale and events pass untouched`, COMMAND, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    desk(on)
    let reply: () => Reply = () => ok(board())
    fakeCommand(on, () => reply())
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('tool.call', () => ({ result: { stdout: 'engine' } }))
    const toasts: string[] = []
    on('ui.toast', (_, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })

    await openBoard($)
    reply = failure
    await clock.advance(20_000)

    const rows = lines(await drawn($))
    // The last good data stays up, marked with its age and the reason's first line.
    expect(rows[1]).toBe(`data is 20s old: ${reason}`)
    expect(rows).toContain('In flight (1)')
    // No toast, no dialog: the failure is one line in the pane.
    expect(toasts).toEqual([])

    // The session's own events go through as if the board were not there.
    expect(await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })).toEqual({ cwd: '/work' })
    expect(await $.tool.call({ tool: 'Bash', command: 'ls' })).toMatchObject({ result: { stdout: 'engine' } })

    // Once the command works again the marker goes.
    reply = () => ok(board())
    await clock.advance(10_000)
    expect(lines(await drawn($)).some(row => row.includes('old:'))).toBe(false)
  })
}

test('a first poll that fails says there is no data yet', COMMAND, async ($, on) => {
  mock.clock(on, { now: NOW })
  desk(on)
  fakeCommand(on, () => ({ exitCode: 1, stdout: '', stderr: '' }))

  await openBoard($)
  expect(lines(await drawn($))).toEqual(['Reading the board…', 'no data yet: fake-board exited 1'])
})

test('only ids, directory names, lanes, states and numbers reach a label', COMMAND, async ($, on) => {
  mock.clock(on, { now: NOW })
  const room = desk(on)
  fakeCommand(on, () =>
    ok({
      orders: [
        {
          id: 'run-1',
          project: '/home/someone/fixture-parent-dir/atlas-api',
          lane: 'lane-a',
          state: 'running',
          round: 1,
          startedAt: NOW - 5 * MINUTE,
          title: 'FIXTURE-TITLE of the order',
          note: 'FIXTURE-NOTE',
          body: 'FIXTURE-PROMPT work order text',
          report: 'FIXTURE-PROMPT report text',
          project_path: '/home/someone/fixture-parent-dir/atlas-api',
        },
      ],
      lanes: [{ name: 'lane-a', costMonth: 1, budgetMonth: 2, api_key: 'FIXTURE-SECRET' }],
      capacity: { running: 1, max: 2 },
      secrets: 'FIXTURE-SECRET',
    }),
  )

  await openBoard($)
  const all = lines(await drawn($)).join('\n')
  expect(all).toContain('run-1 · atlas-api · lane-a · running · r1 · 5m')
  for (const marker of [...SECRET_MARKERS, '/home', 'someone']) expect(all).not.toContain(marker)
  // What is kept for other sessions is the same reduced snapshot.
  const stored = JSON.stringify(room.store.get('snapshot'))
  for (const marker of [...SECRET_MARKERS, '/home', 'someone']) expect(stored).not.toContain(marker)
})

test('reading a home on disk leaves titles, notes, paths and config values out', async ($, on) => {
  mock.clock(on, { now: NOW })
  const room = desk(on)
  fakeHome(on, NOW, [
    { id: '20260115-110000-run-a', state: 'running', lane: 'lane-a', startedAgo: 12 * MINUTE },
    { id: '20260115-090000-review-me', state: 'needs_review', lane: 'lane-b', finishedAgo: 2 * HOUR },
    { id: '20260115-080000-merged', state: 'accepted', lane: 'lane-a', finishedAgo: 3 * HOUR },
  ])

  await openBoard($)
  const all = lines(await drawn($)).join('\n')
  expect(all).toContain('20260115-110000-run-a · atlas-api · lane-a · running')
  const stored = JSON.stringify(room.store.get('snapshot'))
  expect(stored).toContain('20260115-110000-run-a')
  for (const marker of SECRET_MARKERS) {
    expect(all).not.toContain(marker)
    expect(stored).not.toContain(marker)
  }
})

test('a thousand finished orders draw as many elements as five', COMMAND, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  desk(on)
  const history = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `done-${i}`,
      project: 'atlas-api',
      lane: 'lane-a',
      state: i % 3 === 0 ? 'rejected' : 'accepted',
      round: 1,
      startedAt: NOW - 2 * HOUR,
      updatedAt: NOW - HOUR - i * 1000,
    }))
  let reply = () => ok(board(history(5)))
  fakeCommand(on, () => reply())

  await openBoard($)
  const few = await drawn($)
  expect(lines(few)).toContain('Finished in the last 24h: 5')

  reply = () => ok(board(history(1000)))
  await clock.advance(10_000)
  const many = await drawn($)
  // The count line only ever counts what the snapshot keeps: 200 at most.
  expect(lines(many)).toContain('Finished in the last 24h: 200')
  expect(countElements(many)).toBe(countElements(few))
})

test('each section stops at maxRows and counts the rest', { options: { ...COMMAND.options, maxRows: 3 } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  desk(on)
  const many = (state: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: `${state}-${i}`, project: 'p', lane: `lane-${i}`, state, round: 1, startedAt: NOW - i * MINUTE - 30_000, updatedAt: NOW - i * MINUTE - 30_000 }))
  fakeCommand(on, () =>
    ok({
      orders: [...many('running', 40), ...many('check_failed', 500)],
      lanes: Array.from({ length: 40 }, (_, i) => ({ name: `lane-${i}`, costMonth: i + 1, budgetMonth: 100 })),
      capacity: { running: 40, max: 40 },
    }),
  )

  await openBoard($)
  const tree = await drawn($)
  const rows = lines(tree)
  // The snapshot keeps 200 open orders at most, whatever the command prints.
  expect(rows).toContain('Needs you (160)')
  expect(rows).toContain('+157 more')
  expect(rows).toContain('In flight (40)')
  expect(rows).toContain('+37 more')
  expect(rows.filter(row => row.includes(' · check_failed · ')).length).toBe(3)
  expect(rows.filter(row => row.includes(' · running · ')).length).toBe(3)
  // Header, three titles, nine rows, three "more" lines: nothing grows with the input.
  expect(rows.length).toBe(1 + 3 * (1 + 3 + 1))
})

test('at the default maxRows a full board holds 46 elements, the stale line included', COMMAND, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  desk(on)
  const many = (state: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: `${state}-${i}`, project: 'p', lane: `lane-${i}`, state, round: 1, startedAt: NOW - 30_000, updatedAt: NOW - 30_000 }))
  const full = {
    orders: [...many('running', 30), ...many('timeout', 30), ...many('accepted', 30)],
    lanes: Array.from({ length: 30 }, (_, i) => ({ name: `lane-${i}`, costMonth: i + 1, budgetMonth: 100 })),
    capacity: { running: 30, max: 30 },
  }
  let reply: () => Reply = () => ok(full)
  fakeCommand(on, () => reply())

  await openBoard($)
  reply = () => ({ exitCode: 1, stdout: '', stderr: 'down' })
  await clock.advance(10_000)

  const tree = await drawn($)
  expect(lines(tree)[1]).toBe('data is 10s old: fake-board exited 1: down')
  // The root, the header, the stale line, three sections of a title, six rows
  // of two elements each and a "more" line, and the finished count.
  expect(countElements(tree)).toBe(3 + 3 * (1 + 6 * 2 + 1) + 1)
})

test('a command the engine kills at the limit is told from one that never started by the time it took', COMMAND, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  desk(on)
  // The rejection says nothing about time: only the five seconds that passed do.
  on('process.run', async () => {
    await clock.set(clock.now() + 5000)

    return { deny: 'rejected' }
  })

  await openBoard($)
  expect(lines(await drawn($))[1]).toBe('no data yet: fake-board did not finish in 5s')
})

test('a finished order with no time is not counted as finished today', COMMAND, async ($, on) => {
  mock.clock(on, { now: NOW })
  desk(on)
  fakeCommand(on, () =>
    ok({
      orders: [
        { id: 'a', state: 'accepted' },
        { id: 'b', state: 'accepted', updatedAt: NOW - HOUR },
        { id: 'c', state: 'accepted', updatedAt: NOW - 30 * HOUR },
      ],
    }),
  )

  await openBoard($)
  expect(lines(await drawn($))).toEqual([
    expect.stringMatching(/^In flight 0 · needs you 0 · updated /),
    'No open work orders.',
    'Finished in the last 24h: 1',
  ])
})
