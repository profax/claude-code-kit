import { expect, test } from 'claude-code/testing'

import { Ledger } from './ledger'
import type { Transcript } from './ledger'

type Lines = { first: number; last: number; of: number } | null

/** A ledger of a running session on a screen `screenRows` tall: each row noted is a new one. */
function ledger (screenRows = 40) {
  const noted = new Ledger()
  noted.isBatching = false
  noted.screenRows = screenRows
  return noted
}

const row = (requestId: string, component: Transcript['component'], onScreen: Lines) =>
  ({ requestId, component, surface: 'terminal', props: { text: 'Done.', onScreen } }) as unknown as Transcript

test('a card goes above its path where the rows above hold it', () => {
  const noted = ledger()
  noted.note(row('r-0', 'AssistantMessage', { first: 0, last: 9, of: 10 }))
  noted.note(row('r-1', 'AssistantMessage', { first: 0, last: 4, of: 5 }))
  // A file's 8 lines and the heading, above the reply's third line.
  expect(noted.placeOf('r-1', { above: 2, lines: 8 }, 0)).toEqual({ top: -9, lines: 8 })
})

test('a card short of room above goes under the end of the transcript', () => {
  const noted = ledger()
  noted.note(row('r-1', 'AssistantMessage', { first: 0, last: 2, of: 3 }))
  // Above the path only the logo's 5 lines, short of 9; under the transcript 40 - 7 - 5 - 3 - 1.
  expect(noted.placeOf('r-1', { above: 0, lines: 8 }, 0)).toEqual({ top: 3, lines: 8 })
})

test('a card never lies over the logo: Claude Code does not draw it again, and what a card leaves there stays', () => {
  const noted = ledger()
  noted.note(row('r-1', 'AssistantMessage', { first: 0, last: 4, of: 5 }))
  // Three lines above the path and the logo's five would hold 7; the three alone don't, and the
  // card goes under the end of the transcript.
  expect(noted.placeOf('r-1', { above: 3, lines: 6 }, 0)).toEqual({ top: 2, lines: 6 })
})

test('a card where neither side holds it takes the larger side, shortened', () => {
  const noted = ledger(20)
  noted.note(row('r-0', 'AssistantMessage', { first: 6, last: 9, of: 10 }))
  noted.note(row('r-1', 'AssistantMessage', { first: 0, last: 9, of: 10 }))
  // The transcript fills the screen: above the path 4 rows of the reply before and 5 of its own,
  // under it 4, and the 13 a card wants fit neither.
  expect(noted.placeOf('r-1', { above: 5, lines: 12 }, 0)).toEqual({ top: -9, lines: 8 })
})

test('a tool group the engine drew first under its tool\'s id counts once while its turn goes on', () => {
  const noted = ledger()
  noted.note(row('r-1', 'AssistantMessage', { first: 0, last: 4, of: 5 }))
  // Claude Code 2.1.332 draws a new group once as `collapsed-toolu_…` and a fraction of a second
  // later under an id of its own, long before the turn ends; the first is never drawn again.
  noted.note(row('collapsed-toolu_01Ab', 'ToolGroup', { first: 0, last: 1, of: 2 }))
  noted.note(row('collapsed-5f0c2b1e', 'ToolGroup', { first: 0, last: 2, of: 3 }))
  expect(noted.after('r-1')).toEqual([{ id: 'collapsed-5f0c2b1e', rows: 3, foot: 3 }])
})

test('a card above the path when the reply\'s place on screen is not known', () => {
  expect(ledger().placeOf('r-1', { above: 0, lines: 3 }, 0)).toEqual({ top: -4, lines: 3 })
})

test('the rows drawn after a reply are counted down to each one\'s foot, up to the first one cut', () => {
  const noted = ledger()
  noted.note(row('r-1', 'AssistantMessage', { first: 0, last: 4, of: 5 }))
  noted.note(row('d-1', 'TurnDuration', { first: 0, last: 0, of: 1 }))
  noted.note(row('m-2', 'UserMessage', { first: 0, last: 1, of: 2 }))
  noted.note(row('r-2', 'AssistantMessage', { first: 0, last: 2, of: 8 }))
  expect(noted.after('r-1')).toEqual([{ id: 'd-1', rows: 1, foot: 1 }, { id: 'm-2', rows: 2, foot: 3 }, { id: 'r-2', rows: 8, foot: 11 }])
  expect(noted.note(row('m-2', 'UserMessage', { first: 0, last: 1, of: 2 }))).toBe(false)
})
