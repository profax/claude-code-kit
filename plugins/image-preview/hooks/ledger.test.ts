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
  // 20 rows of the reply above, the logo's 5 and the prompt's own empty top row: more than the 3
  // under it.
  expect(low.placeOf(1, 'm-1/sent:1', 'm-1')).toEqual({ id: 1, target: 'm-1/sent:1', host: 'm-1', rows: 26, edge: 'first' })

  const high = ledger()
  high.note(row('m-1', 'UserMessage', { first: 0, last: 1, of: 2 }, '[Image #1]'))
  high.note(row('r-1', 'AssistantMessage', { first: 0, last: 19, of: 20 }))
  expect(high.placeOf(1, 'm-1/sent:1', 'm-1')).toEqual({ id: 1, target: 'm-1/sent:1', host: 'r-1', rows: 20, edge: 'last' })
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
