// dispatch-board's type contract: the normalized board snapshot (the public
// data contract, see README) and the one value the mod keeps in `$.state`.

/** Which section of the board an order belongs to. */
export type Bucket = 'active' | 'attention' | 'done'

/** One delegated work order, already reduced to what the board may draw. */
export type Order = {
  /** The orchestrator's order id. */
  id: string
  /** Directory name of the project (a basename, never a path). */
  project: string
  /** The lane (worker, model or queue) the order runs on. */
  lane: string
  /** The orchestrator's state name, such as `running` or `needs_review`. */
  state: string
  /** Which attempt this is, starting at 1. */
  round: number
  /** Epoch milliseconds the current attempt started, or it was queued. */
  startedAt: number | null
  /** Epoch milliseconds of the last sign of life, or when it finished. */
  updatedAt: number | null
  /** Short title; present only when the `showTitles` option is on. */
  title?: string
  /** Overrides the section a state name would be sorted into. */
  bucket?: Bucket
}

/** One lane's spend against its monthly budget. */
export type Lane = {
  name: string
  /** Spend this calendar month, in the lane's currency unit. */
  costMonth: number
  /** Monthly budget; 0 means the lane has no cap. */
  budgetMonth: number
}

/** How many orders hold a slot, and how many slots there are. */
export type Capacity = {
  running: number
  /** Null when the source does not say. */
  max: number | null
}

/** The normalized board snapshot every data source is mapped to. */
export type Snapshot = {
  orders: Order[]
  lanes: Lane[]
  capacity: Capacity | null
}

/** What the pane draws from: the last good snapshot and how the last poll went. */
export type Board = {
  /** The last good snapshot; null before the first one. */
  snap: Snapshot | null
  /** Epoch milliseconds `snap` was fetched. */
  at: number
  /** Epoch milliseconds of the poll that wrote this value. */
  now: number
  /** First line of why the last poll failed; null when it worked. */
  error: string | null
  /** Fingerprint of the drawn view, so an unchanged poll writes nothing. */
  fp: string
}

declare module 'claude-code' {
  interface PluginState {
    'dispatch-board': { board: Shaped<Board> }
  }
}
