// Drawing: turns a View into Box and Text only, so the same tree is valid on
// the terminal, the desktop app, VS Code and mobile. One order is one row.

import type { Color, Elements, RenderSurface } from 'claude-code'

import { cells, fit, formatClock, labels } from './model'
import type { Config, LaneView, RowView, Tone, View } from './model'

type Kit = Pick<Elements[RenderSurface], 'Box' | 'Text'>

const TONE: Record<Tone, Color | undefined> = {
  normal: undefined,
  dim: undefined,
  warning: 'warning',
  error: 'error',
}

const SEP = ' · '
const MIN_ID_CELLS = 8

function orderRow(kit: Kit, row: RowView, columns: number) {
  const { Text } = kit
  const lead = row.where === '' ? SEP : `${SEP}${row.where}${SEP}`
  const tail = `${SEP}${row.tail}${row.title === '' ? '' : `${SEP}${row.title}`}`
  // The id gives way first: everything after it says what to do about the order.
  const rest = cells(lead) + cells(row.state) + cells(`${SEP}${row.tail}`)
  const id = fit(row.id, Math.max(MIN_ID_CELLS, columns - rest))

  return (
    <Text wrap="truncate-end" dimColor={row.tone === 'dim'}>
      {id}
      {lead}
      <Text color={TONE[row.tone]}>{row.state}</Text>
      {tail}
    </Text>
  )
}

function laneRow(kit: Kit, lane: LaneView) {
  const { Text } = kit

  return (
    <Text wrap="truncate-end">
      {lane.name}
      {SEP}
      <Text color={TONE[lane.tone]}>{lane.text}</Text>
    </Text>
  )
}

/** The whole pane. `columns` is the body's width in cells. */
export function draw(kit: Kit, view: View, config: Config, columns: number, isGlance: boolean) {
  const { Box, Text } = kit
  const t = labels(config.lang)
  const header = view.hasData
    ? `${view.header}${SEP}${t.updated} ${formatClock(view.at)}`
    : view.header
  const head = [
    <Text bold wrap="truncate-end">
      {header}
    </Text>,
  ]
  if (view.stale !== '') {
    head.push(
      <Text color="warning" wrap="truncate-end">
        {view.stale}
      </Text>,
    )
  }
  // A minimized pane (the desktop app's widget) shows the headline alone.
  if (isGlance || !view.hasData) return <Box flexDirection="column">{head}</Box>

  const body = []
  const more = (shown: number, total: number) => {
    if (total > shown) body.push(<Text dimColor>{t.more(total - shown)}</Text>)
  }
  if (view.attentionTotal > 0) {
    body.push(<Text bold>{`${t.attention} (${view.attentionTotal})`}</Text>)
    for (const row of view.attention) body.push(orderRow(kit, row, columns))
    more(view.attention.length, view.attentionTotal)
  }
  if (view.activeTotal > 0) {
    body.push(<Text bold>{`${t.active} (${view.activeTotal})`}</Text>)
    for (const row of view.active) body.push(orderRow(kit, row, columns))
    more(view.active.length, view.activeTotal)
  }
  if (view.attentionTotal === 0 && view.activeTotal === 0) {
    body.push(<Text dimColor>{t.empty}</Text>)
  }
  if (view.lanesTotal > 0) {
    body.push(<Text bold>{t.lanes}</Text>)
    for (const lane of view.lanes) body.push(laneRow(kit, lane))
    more(view.lanes.length, view.lanesTotal)
  }
  if (view.done > 0) body.push(<Text dimColor>{t.done(view.done)}</Text>)

  return (
    <Box flexDirection="column">
      {head}
      {body}
    </Box>
  )
}
