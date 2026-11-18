// An agent-dispatch home held in memory, for tests that stand in for `$.fs`.
//
// The file layout and the key names of meta.json, state.json and config.json
// follow a real home (surveyed for key names and value types only). Every
// value is synthetic. `note`, `prompt_text`, the title and the project's
// parent directories hold marker text that tests assert is never drawn.

import type { On } from 'claude-code'

import { iso } from '../kit'

export const HOME = '/fixture-user'
export const ROOT = `${HOME}/.agent-dispatch`

export const SECRET_MARKERS = [
  'FIXTURE-NOTE',
  'FIXTURE-PROMPT',
  'FIXTURE-TITLE',
  'fixture-parent-dir',
  'FIXTURE-SECRET',
]

export type FakeOrder = {
  id: string
  state: string
  lane: string
  project?: string
  attempt?: number
  /** Milliseconds before `now` the last attempt started. */
  startedAgo?: number
  /** Milliseconds before `now` it finished; left out while it is open. */
  finishedAgo?: number
  /** One cost per attempt, all on `lane`. */
  costs?: number[]
  holdsSlot?: boolean
  /** Milliseconds before `now` its newest events file changed. */
  activeAgo?: number
}

export type FakeHome = {
  files: Map<string, string>
  mtimes: Map<string, number>
  reads: string[]
  lists: string[]
  /** Adds an order or replaces its files. */
  put: (order: FakeOrder) => void
}

const MINUTE = 60_000

export function fakeHome(on: On, now: number, orders: readonly FakeOrder[]): FakeHome {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const reads: string[] = []
  const lists: string[] = []

  const put = (order: FakeOrder) => {
    const dir = `${ROOT}/orders/${order.id}`
    const attempt = order.attempt ?? 1
    const started = now - (order.startedAgo ?? 30 * MINUTE)
    const finished = order.finishedAgo === undefined ? null : now - order.finishedAgo
    const costs = order.costs ?? [0.5]
    files.set(
      `${dir}/meta.json`,
      JSON.stringify({
        id: order.id,
        kind: 'impl',
        worker: order.lane,
        model: 'fixture-model',
        project: `/fixture-parent-dir/work/${order.project ?? 'atlas-api'}`,
        title: `FIXTURE-TITLE for ${order.id} that is long enough to need cutting`,
        created_at: iso(started - 5 * MINUTE),
        base: 'main',
        base_sha: '0'.repeat(40),
        branch: `dispatch/${order.id}`,
        worktree: `/fixture-parent-dir/worktrees/${order.id}`,
        priority: 0,
        timeout_min: 60.0,
        web: false,
        project_file: {},
      }),
    )
    files.set(
      `${dir}/state.json`,
      JSON.stringify({
        state: order.state,
        note: 'FIXTURE-NOTE that must never be drawn',
        prompt_text: 'FIXTURE-PROMPT that must never be drawn',
        attempt,
        attempts: costs.map((cost, i) => ({
          attempt: i + 1,
          worker: order.lane,
          model: 'fixture-model',
          kind: i === 0 ? 'first' : 'redo',
          started_at: iso(started - (costs.length - 1 - i) * 10 * MINUTE),
          finished_at: finished === null ? null : iso(finished),
          cost,
          exit_code: 0,
          timed_out: false,
          aborted: false,
          tokens: { total: 1000 },
        })),
        auto_retries: 0,
        stall_retries: 0,
        check: null,
        cost: costs.reduce((a, b) => a + b, 0),
        current_worker: order.lane,
        slot_worker: order.holdsSlot ? order.lane : null,
        diff: {},
        pid: 4242,
        worker_pid: 4243,
        queued_at: iso(started - 2 * MINUTE),
        started_at: order.state === 'queued' ? null : iso(started),
        finished_at: finished === null ? null : iso(finished),
        tokens: { total: 1000 },
      }),
    )
    mtimes.set(`${dir}/state.json`, started)
    files.set(`${dir}/events-1.jsonl`, '')
    mtimes.set(`${dir}/events-1.jsonl`, now - (order.activeAgo ?? 20_000))
    files.set(`${dir}/order.md`, 'FIXTURE-PROMPT body')
    mtimes.set(`${dir}/order.md`, now)
  }

  for (const order of orders) put(order)
  files.set(
    `${ROOT}/config.json`,
    JSON.stringify({
      version: 1,
      max_parallel: 4,
      secrets: { fixture_key: 'FIXTURE-SECRET value' },
      workers: {
        'lane-a': { budget_usd_month: 10, max_parallel: 2, enabled: true },
        'lane-b': { budget_usd_month: 5, max_parallel: 2, enabled: true },
        'lane-c': { max_parallel: 1, enabled: true },
        'lane-idle': { budget_usd_month: 20, max_parallel: 1, enabled: true },
      },
    }),
  )

  mock(on, files, mtimes, reads, lists)

  return { files, mtimes, reads, lists, put }
}

function mock(
  on: On,
  files: Map<string, string>,
  mtimes: Map<string, number>,
  reads: string[],
  lists: string[],
): void {
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.read', (_, e) => {
    reads.push(e.path)
    const body = files.get(e.path)

    return body === undefined ? { deny: 'no such file' } : { value: body }
  })
  on('fs.list', (_, e) => {
    const dir = String(e.path).replace(/\/+$/, '')
    lists.push(dir)
    const seen = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [path, body] of files) {
      if (!path.startsWith(`${dir}/`)) continue
      const rest = path.slice(dir.length + 1)
      const name = rest.split('/')[0] ?? ''
      const isFile = !rest.includes('/')
      seen.set(name, {
        name,
        kind: isFile ? 'file' : 'dir',
        size: isFile ? body.length : 0,
        mtimeMs: isFile ? (mtimes.get(path) ?? 0) : 0,
        isLink: false,
      })
    }

    return seen.size === 0 ? { deny: 'no such directory' } : { value: [...seen.values()] }
  })
}
