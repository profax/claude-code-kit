import { expect, test } from 'claude-code/testing'

import { Ledger } from './ledger'
import type { Row } from './ledger'

type Lines = { first: number; last: number; of: number } | null

/** A ledger of a running session: past its first batch, each row noted is a new one. */
function ledger (screenRows = 40) {
  const noted = new Ledger()
  noted.isBatching = false
  noted.screenRows = screenRows
  return noted
}

const row = (requestId: string, component: Row['component'], onScreen: Lines, text = 'Done.') =>
  ({ requestId, component, surface: 'terminal', props: { text, origin: { kind: 'composer' }, onScreen } }) as unknown as Row

test('a band chip\'s card stays in the band, over no row', () => {
  expect(ledger().placeOf(1, 'band/chip:1')).toEqual({ id: 1, target: 'band/chip:1', host: null, rows: 0, edge: 'last' })
})

test('a sent prompt\'s card goes to the side of the prompt with more room', () => {
  const low = ledger()
  low.note(row('r-0', 'AssistantMessage', { first: 0, last: 19, of: 20 }))
  low.note(row('m-1', 'UserMessage', { first: 0, last: 1, of: 2 }, '[Image #1]'))
  low.note(row('r-1', 'AssistantMessage', { first: 0, last: 2, of: 3 }))
  // 20 rows of the reply above and the prompt's own empty top row, never the logo: Claude Code does
  // not draw the logo again, and what a card leaves there stays.
  expect(low.placeOf(1, 'm-1/sent:1', 'm-1')).toEqual({ id: 1, target: 'm-1/sent:1', host: 'm-1', rows: 21, edge: 'first' })

  const high = ledger()
  high.note(row('m-1', 'UserMessage', { first: 0, last: 1, of: 2 }, '[Image #1]'))
  high.note(row('r-1', 'AssistantMessage', { first: 0, last: 19, of: 20 }))
  expect(high.placeOf(1, 'm-1/sent:1', 'm-1')).toEqual({ id: 1, target: 'm-1/sent:1', host: 'r-1', rows: 20, edge: 'last' })
})

test('a tool group the engine drew first under its tool\'s id counts once while its turn goes on', () => {
  const noted = ledger()
  noted.note(row('m-1', 'UserMessage', { first: 0, last: 1, of: 2 }, '[Image #1]'))
  // Claude Code 2.1.332 draws a new group once as `collapsed-toolu_…` and a fraction of a second
  // later under an id of its own, long before the turn ends; the first is never drawn again.
  noted.note(row('collapsed-toolu_01Ab', 'ToolGroup', { first: 0, last: 1, of: 2 }))
  noted.note(row('collapsed-5f0c2b1e', 'ToolGroup', { first: 0, last: 2, of: 3 }))
  noted.note(row('r-1', 'AssistantMessage', { first: 0, last: 1, of: 2 }))
  noted.note(row('collapsed-toolu_01Cd', 'ToolGroup', { first: 0, last: 1, of: 2 }))
  noted.note(row('collapsed-9a7d3e40', 'ToolGroup', { first: 0, last: 1, of: 2 }))
  noted.note(row('r-2', 'AssistantMessage', { first: 0, last: 9, of: 10 }))
  // Under the prompt the two groups and the two replies, 3 + 2 + 2 + 10: a card four rows taller
  // would lie over the label that opened it.
  expect(noted.placeOf(1, 'm-1/sent:1', 'm-1')).toEqual({ id: 1, target: 'm-1/sent:1', host: 'r-2', rows: 17, edge: 'last' })
})

test('a sent prompt\'s card that fits neither side has no place', () => {
  const noted = ledger(10)
  noted.note(row('m-1', 'UserMessage', { first: 0, last: 1, of: 2 }, '[Image #1]'))
  noted.note(row('r-1', 'AssistantMessage', { first: 0, last: 2, of: 3 }))
  expect(noted.placeOf(1, 'm-1/sent:1', 'm-1')).toBeNull()
})

test('a prompt with images that went off screen tells the row under its list to draw its chips', () => {
  const noted = ledger()
  noted.note(row('m-1', 'UserMessage', { first: 0, last: 1, of: 2 }, '[Image #1]'))
  noted.note(row('r-1', 'AssistantMessage', { first: 0, last: 9, of: 10 }))
  expect(noted.hiddenPromptAbove('r-1')).toBeUndefined()
  expect(noted.note(row('m-1', 'UserMessage', null, '[Image #1]'))).toBe(true)
  expect(noted.hiddenPromptAbove('r-1')).toBe('m-1')
})
