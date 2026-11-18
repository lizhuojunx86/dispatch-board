// Shared test helpers: stand-ins for the engine calls the mod makes, and
// readers for the tree it draws.

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

/** A fixed "now": mid-month, so an hour ago is still this UTC month. */
export const NOW = Date.UTC(2026, 0, 15, 12, 0, 0)

export type PaneTarget = {
  plugin: 'dispatch-board'
  component: 'Pane'
  requestId: 'dispatch-board'
  props: {
    title: string
    isFocused: boolean
    bodyColumns: number
    placement: 'dock' | 'inline' | 'widget'
    scroll: { offset: number; bodyRows: number }
    view: Record<string, never>
  }
}

export const PANE: PaneTarget = {
  plugin: 'dispatch-board',
  component: 'Pane',
  requestId: 'dispatch-board',
  props: {
    title: 'Dispatch',
    isFocused: false,
    bodyColumns: 72,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
}

/** Wide enough that no id is cut: for tests that read whole rows. */
export const WIDE: PaneTarget = { ...PANE, props: { ...PANE.props, bodyColumns: 140 } }

export const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

/** Every string the tree would draw, in order. */
export function texts(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  if (typeof node === 'object' && node !== null) return texts((node as { children?: unknown }).children)

  return []
}

/** The tree as one line of text per top-level row. */
export function lines(root: unknown): string[] {
  const children = (root as { children?: unknown }).children
  const rows = Array.isArray(children) ? children.flat(Infinity) : [children]

  return rows.filter(row => row !== null && row !== undefined && row !== false).map(row => texts(row).join(''))
}

/** How many elements the tree holds, strings not counted. */
export function countElements(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((sum: number, child) => sum + countElements(child), 0)
  if (typeof node === 'object' && node !== null) {
    return 1 + countElements((node as { children?: unknown }).children)
  }

  return 0
}

export type Desk = {
  /** Whether the pane is open, as `$.ui.panes()` answers it. */
  isOpen: boolean
  /** Whether it is the pane shown, not a tab behind another. */
  isShown: boolean
  /** The store's contents: another session's writes go straight in here. */
  store: Map<string, unknown>
  storeWrites: number
}

/** Answers the engine calls every test needs: the command, the pane, the store. */
export function desk(on: On): Desk {
  const state: Desk = { isOpen: false, isShown: true, store: new Map(), storeWrites: 0 }
  on('command.register', () => ({ value: { command: 'dispatch-board' } }))
  on('ui.open', () => {
    state.isOpen = true

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: state.isOpen
      ? [
          {
            id: 'dispatch-board',
            title: 'Dispatch',
            isShown: state.isShown,
            isFocused: false,
            isPlaced: true,
          },
        ]
      : [],
  }))
  on('store.get', (_, e) => ({ value: state.store.get(e.key) }))
  on('store.set', (_, e) => {
    state.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    state.storeWrites += 1

    return { value: undefined }
  })

  return state
}

/** Types `/dispatch-board` at the prompt, as the person does. */
export async function openBoard($: Engine): Promise<void> {
  await $.command.run({
    command: 'dispatch-board',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
}

/** The pane's tree as the terminal would be handed it. */
export async function drawnTree($: Engine, target: PaneTarget = WIDE): Promise<unknown> {
  const ui = await $.ui.mount({ ...target, surface: 'terminal' })
  const tree = await ui.drawn()
  await ui.unmount()

  return tree
}

export function iso(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`
}
