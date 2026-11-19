// Cross-check against the dispatcher itself.
//
// The built-in adapter reads agent-dispatch's state files directly, which
// means it repeats that tool's file layout and its spend rule. The fixture
// in ./fixtures/conformance.generated.ts is a synthetic home together with
// what `agent-dispatch board --json`, the tool's own read-only snapshot,
// printed for it. This test reads the same home through the adapter and
// fails on any difference in what the board would draw.
//
// To check against a newer agent-dispatch, capture again and run the tests:
//
//   python3 scripts/conformance.py /path/to/agent-dispatch
//   claude plugin test .

import { expect, test } from 'claude-code/testing'

import { newHomeCache, readHome } from '../adapters/agent-dispatch'
import { bucketOf, normalize } from '../hooks/model'
import { CAPTURED } from './fixtures/conformance.generated'

const HOME = '/fixture-user'
const ROOT = `${HOME}/.agent-dispatch`

const FILES: Record<string, string> = CAPTURED.files
const MTIMES: Record<string, number> = CAPTURED.mtimes

/** The two engine calls the adapter makes, answered from the captured home. */
function capturedEngine(): Parameters<typeof readHome>[0] {
  const engine = {
    env: { get: async (name: string) => (name === 'HOME' ? HOME : undefined) },
    fs: {
      read: async (path: string) => {
        const text = FILES[path.slice(ROOT.length + 1)]
        if (text === undefined) throw new Error(`no such file: ${path}`)

        return text
      },
      list: async (dir: string) => {
        const prefix = `${dir.slice(ROOT.length + 1)}/`
        const entries = new Map<string, { name: string; kind: 'file' | 'dir'; mtimeMs: number }>()
        for (const path of Object.keys(FILES)) {
          if (!path.startsWith(prefix)) continue
          const rest = path.slice(prefix.length)
          const name = rest.split('/')[0] ?? ''
          const isFile = !rest.includes('/')
          entries.set(name, { name, kind: isFile ? 'file' : 'dir', mtimeMs: isFile ? (MTIMES[path] ?? 0) : 0 })
        }
        if (entries.size === 0) throw new Error(`no such directory: ${dir}`)

        return [...entries.values()]
      },
    },
  }

  return engine as unknown as Parameters<typeof readHome>[0]
}

const second = (ms: number | null) => (ms === null ? null : Math.floor(ms / 1000))

/** What the board would draw from a snapshot, in a form two sources can be held against. */
function drawn(raw: unknown, now: number) {
  const snap = normalize(raw, now, false)
  const open = snap.orders
    .filter(order => bucketOf(order) !== 'done')
    .map(order => ({
      id: order.id,
      project: order.project,
      lane: order.lane,
      state: order.state,
      round: order.round,
      startedAt: second(order.startedAt),
      updatedAt: second(order.updatedAt),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const lanes: Record<string, { cost: number; budget: number }> = {}
  for (const lane of snap.lanes) {
    // A lane with neither spend nor a cap draws nothing, and a source may list it or not.
    if (lane.costMonth === 0 && lane.budgetMonth === 0) continue
    lanes[lane.name] = { cost: Math.round(lane.costMonth * 1e6) / 1e6, budget: lane.budgetMonth }
  }

  return {
    open,
    finishedToday: snap.orders.filter(order => bucketOf(order) === 'done').length,
    lanes,
    capacity: snap.capacity,
  }
}

test('the file adapter draws what `agent-dispatch board --json` reports for the same home', async () => {
  const now = CAPTURED.now
  const fromTool = drawn(CAPTURED.board, now)
  const fromFiles = drawn(await readHome(capturedEngine(), newHomeCache(), now), now)

  // The capture is not vacuous: six open orders, one finished today, one half-written order left out.
  expect(fromTool.open.map(order => order.state)).toEqual([
    'queued',
    'running',
    'reviewing',
    'needs_review',
    'check_failed',
    'no_changes',
  ])
  expect(fromTool.finishedToday).toBe(1)
  expect(CAPTURED.board.skipped).toBe(1)

  expect(fromFiles).toEqual(fromTool)
})
