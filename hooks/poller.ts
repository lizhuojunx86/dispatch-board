// The poll: where a snapshot comes from, how sessions share one, and when
// the pane is told to redraw. Every function that takes `$` is declared at
// the module's top level and swallows its own failures: a broken board must
// never reach the session.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Timer } from 'claude-code'

import { fromStatusRows, isStatusRows, newHomeCache, readHome } from '../adapters/agent-dispatch'
import type { Snapshot } from '../types'
import { demoSnapshot } from './demo'
import {
  BOARD_SHAPE,
  BoardError,
  EMPTY_BOARD,
  PANE,
  activeCount,
  basename,
  buildView,
  fingerprint,
  isRecord,
  normalize,
  reasonLine,
} from './model'
import type { Config } from './model'

// `claude plugin validate` reads a state reference only from the file that
// uses it, so register.tsx declares this same atom again.
const board = atom({ plugin: 'dispatch-board', key: 'board' } as const, EMPTY_BOARD, {
  shape: BOARD_SHAPE,
})

const STORE_KEY = 'snapshot'
const COMMAND_TIMEOUT_MS = 5000
// A timer fires a little early or late; a poll this close to due counts as due.
const SLACK_MS = 500

type Shared = { at: number; source: string; snap: Snapshot }

// Module state: lost on a hot reload, which only costs one extra fetch.
let timer: Timer | null = null
let isBusy = false
let lastCheckAt = 0
const homeCache = newHomeCache()

async function expandHome($: EngineInterface, argv: readonly string[]): Promise<string[]> {
  if (!argv.some(arg => arg.startsWith('~/'))) return [...argv]
  const home = (await $.env.get('HOME')) ?? ''

  return argv.map(arg => (home !== '' && arg.startsWith('~/') ? `${home}${arg.slice(1)}` : arg))
}

/** Runs the configured command (argument vector, no shell) and parses what it prints. */
async function runCommand($: EngineInterface, config: Config, now: number): Promise<unknown> {
  const argv = await expandHome($, config.argv)
  const name = basename(argv[0] ?? '')
  let result
  const startedAt = await $.clock.now()
  try {
    result = await $.process.run(argv, { timeoutMs: COMMAND_TIMEOUT_MS })
  } catch (err) {
    // The engine rejects both for a command it cannot start and for one it
    // had to kill. Time tells them apart whatever the rejection says.
    const elapsed = (await $.clock.now()) - startedAt
    const isTimeout =
      elapsed >= COMMAND_TIMEOUT_MS - SLACK_MS ||
      /timed? ?out/i.test(String(isRecord(err) ? err.message : err))
    throw new BoardError(
      isTimeout
        ? `${name} did not finish in ${COMMAND_TIMEOUT_MS / 1000}s`
        : `${name} could not be started`,
    )
  }
  if (result.exitCode !== 0) {
    const why = reasonLine(result.stderr)
    throw new BoardError(`${name} exited ${result.exitCode}${why === '' ? '' : `: ${why}`}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new BoardError(`${name} printed invalid JSON`)
  }

  return isStatusRows(parsed) ? fromStatusRows(parsed, now) : parsed
}

async function fetchSnapshot($: EngineInterface, config: Config, now: number): Promise<Snapshot> {
  const raw =
    config.argv.length > 0 ? await runCommand($, config, now) : await readHome($, homeCache, now)

  return normalize(raw, now, config.showTitles)
}

async function loadShared($: EngineInterface, config: Config): Promise<Shared | null> {
  try {
    const value = await $.store.get(STORE_KEY)
    if (!isRecord(value) || value.source !== config.source || typeof value.at !== 'number') {
      return null
    }

    // What another session stored is data like any other: reduce it again.
    return { at: value.at, source: config.source, snap: normalize(value.snap, value.at, config.showTitles) }
  } catch {
    return null
  }
}

/**
 * One poll. Takes the snapshot another session just stored when it is fresh
 * enough, fetches otherwise, and writes `$.state` (which redraws the pane)
 * only when what would be drawn has changed.
 */
export async function tick($: EngineInterface, config: Config, isForced = false): Promise<void> {
  if (isBusy) return
  isBusy = true
  try {
    const mine = (await $.ui.panes()).find(pane => pane.id === PANE)
    if (!mine) {
      // The pane was closed: stop the timer, so nothing runs until it is opened again.
      timer?.cancel()
      timer = null

      return
    }
    if (!isForced && (!mine.isPlaced || !mine.isShown)) return

    const now = await $.clock.now()
    const prev = await read($, board)
    let snap = prev.snap
    let at = prev.at
    let error: string | null = null

    if (config.demo) {
      snap = normalize(demoSnapshot(now), now, config.showTitles)
      at = now
    } else {
      // A snapshot another session stored is taken whenever it is newer: free.
      const shared = await loadShared($, config)
      const isAdopted = shared !== null && shared.at > at && shared.at <= now + SLACK_MS
      if (shared && isAdopted) {
        snap = shared.snap
        at = shared.at
      }
      // Ten seconds while work is in flight, a minute while nothing is.
      const period = activeCount(snap) > 0 ? config.intervalMs : config.idleMs
      if (isForced || now - lastCheckAt >= period - SLACK_MS) {
        lastCheckAt = now
        // Younger than half a period is fresh enough: with several sessions
        // open, one of them fetches and the rest read what it stored.
        if (snap === null || now - at >= period / 2) {
          try {
            snap = await fetchSnapshot($, config, now)
            at = now
            const record: Shared = { at, source: config.source, snap }
            await $.store.set(STORE_KEY, record).catch(() => {})
          } catch (err) {
            error = err instanceof BoardError ? err.message : 'could not read the board'
          }
        }
      } else if (!isAdopted) {
        // Not due and nothing newer to show: the last poll's failure still stands.
        error = prev.error
      }
    }

    const next = { snap, at, now, error }
    const fp = fingerprint(buildView(next, config))
    if (fp !== prev.fp) await update($, board, () => ({ ...next, fp }))
  } catch {
    // Swallowed on purpose: the next tick tries again.
  } finally {
    isBusy = false
  }
}

/** Starts the poll timer (once) and polls right away. */
export async function startPolling($: EngineInterface, config: Config): Promise<void> {
  if (timer === null) {
    timer = $.clock.every(config.intervalMs, () => {
      void tick($, config)
    })
  }
  await tick($, config, true)
}

/** After a reload: carries on polling when the pane is still open. */
export async function resumePolling($: EngineInterface, config: Config): Promise<void> {
  const panes = await $.ui.panes()
  if (panes.some(pane => pane.id === PANE)) await startPolling($, config)
}
