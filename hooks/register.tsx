// dispatch-board: a side pane that shows where delegated work orders stand
// and what each lane has spent this month.
//
// It only watches. It hooks nothing that could change an input, a result, a
// prompt or a permission decision; it adds nothing to the conversation, calls
// no model and makes no network request. Whatever goes wrong in here stays in
// here: every hook hands the event on untouched.

import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'

import { BOARD_SHAPE, EMPTY_BOARD, PANE, buildView, readConfig } from './model'
import { resumePolling, startPolling } from './poller'
import { draw } from './view'

// The pane's id and the slash command's name are both PANE ('dispatch-board').
// The matchers below spell it out, so `claude plugin validate` can read them.
const TITLE = 'Dispatch'

const board = atom({ plugin: 'dispatch-board', key: 'board' } as const, EMPTY_BOARD, {
  shape: BOARD_SHAPE,
})

export const register: Register = (on, options) => {
  const config = readConfig(options)

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'dispatch-board',
        description: 'Show delegated work orders and lane budgets in a side pane',
        immediate: true,
      })
      // Only after a reload with the pane still open: nothing polls unasked.
      await resumePolling($, config)
    } catch {
      // The session starts the same with or without the board.
    }

    return next(e)
  })

  on('command.run', { command: 'dispatch-board' }, async $ => {
    try {
      await $.ui.open({ id: PANE, title: TITLE })
      await startPolling($, config)
    } catch {
      // Nothing to add: the pane draws its own state, or is not there.
    }

    // No text: the command leaves nothing in the conversation.
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: 'dispatch-board' }, async ($, e) => {
    const kit = $.ui.resolve(e)
    try {
      const view = buildView(await read($, board), config)

      return draw(kit, view, config, e.props.bodyColumns, e.props.placement === 'widget')
    } catch {
      const { Text } = kit

      return <Text dimColor>dispatch-board has nothing to show.</Text>
    }
  })
}
