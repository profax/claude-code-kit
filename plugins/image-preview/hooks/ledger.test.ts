import { expect, test } from 'claude-code/testing'

import { Ledger } from './ledger'
import type { Row } from './ledger'

type Lines = { first: number; last: number; of: number } | null

/** A ledger of a running session, each row noted a new one. */
function ledger (screenRows = 40) {
  const noted = new Ledger()
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

test('rows drawn a block at a time, the newest block first, stand in the transcript\'s order', () => {
  const noted = new Ledger()
  noted.screenRows = 40
  const id = (n: number) => `0000000${n}-aaaa-4bbb-8ccc-000000000000`
  const message = (n: number, role: 'user' | 'assistant', toolUses: string[] = []) =>
    ({ role, text: '', uuid: `0000000${n}-aaaa-4bbb-8ccc-${String(n).padStart(12, '1')}`, toolUses: toolUses.map(tool_use_id => ({ tool_use_id, tool: 'Bash', input: {} })) })
  // As Claude Code 2.1.332 drew a copy of a session when it opened: the screen's block, then the
  // block above it. A prompt queued while a turn ran is no message of the transcript, nor is a
  // turn's duration row; each comes right after the row drawn before it.
  noted.note(row(id(6), 'UserMessage', { first: 0, last: 1, of: 2 }, 'yes'))
  noted.note(row(id(7), 'AssistantMessage', { first: 0, last: 1, of: 5 }))
  noted.note(row('toolu_01Queue', 'ToolUse', null))
  noted.note(row('queued-1', 'UserMessage', null, 'and this'))
  noted.note(row(id(9), 'AssistantMessage', null))
  noted.note(row('turn-2', 'TurnDuration', null))
  noted.note(row(id(1), 'AssistantMessage', null))
  noted.note(row('turn-0', 'TurnDuration', { first: 0, last: 1, of: 2 }))
  noted.note(row(id(2), 'UserMessage', { first: 0, last: 1, of: 2 }, '[Image #1]'))
  noted.note(row(id(3), 'AssistantMessage', { first: 0, last: 2, of: 3 }))
  noted.note(row(`collapsed-${id(4)}`, 'ToolGroup', { first: 0, last: 1, of: 2 }))
  noted.note(row(id(5), 'AssistantMessage', { first: 0, last: 3, of: 4 }))
  noted.note(row('turn-1', 'TurnDuration', { first: 0, last: 1, of: 2 }))
  noted.learn([message(1, 'assistant'), message(2, 'user'), message(3, 'assistant'), message(4, 'assistant'), message(5, 'assistant'), message(6, 'user'), message(7, 'assistant'), message(8, 'assistant', ['toolu_01Queue']), message(9, 'assistant')])
  // Above the image prompt only the duration row before it and its own empty top row; under it its
  // turn, the next prompt and the start of the reply: 3 + 2 + 4 + 2 + 2 + 2.
  expect(noted.placeOf(1, `${id(2)}/sent:1`, id(2))).toEqual({ id: 1, target: `${id(2)}/sent:1`, host: id(7), rows: 15, edge: 'last' })
  expect([...noted.order()].sort((a, b) => a[1] - b[1]).map(([requestId]) => requestId))
    .toEqual([id(1), 'turn-0', id(2), id(3), `collapsed-${id(4)}`, id(5), 'turn-1', id(6), id(7), 'toolu_01Queue', 'queued-1', id(9), 'turn-2'])
})

test('a prompt queued while a turn ran stands right after the message stored before it, not after the row drawn before it', () => {
  const noted = new Ledger()
  noted.screenRows = 48
  const id = (n: number) => `0000000${n}-aaaa-4bbb-8ccc-000000000000`
  const uuid = (n: number) => `0000000${n}-aaaa-4bbb-8ccc-${String(n).padStart(12, '1')}`
  // As Claude Code 2.1.332 drew a copy of a session scrolled back to a prompt with an image that
  // was queued while a turn ran: the reply under the prompt was drawn before it.
  noted.note(row('toolu_01Edit', 'ToolUse', { first: 2, last: 17, of: 18 }))
  noted.note(row(`collapsed-${id(2)}`, 'ToolGroup', { first: 0, last: 1, of: 2 }))
  noted.note(row(id(5), 'AssistantMessage', { first: 0, last: 1, of: 2 }))
  noted.note(row(id(4), 'UserMessage', { first: 0, last: 1, of: 2 }, '[Image #6]'))
  noted.note(row('toolu_01Next', 'ToolUse', { first: 0, last: 14, of: 16 }))
  noted.learn([
    { uuid: uuid(1), toolUses: [{ tool_use_id: 'toolu_01Edit' }] },
    { uuid: uuid(2), toolUses: [] },
    { uuid: uuid(3), toolUses: [] },
    { uuid: uuid(5), toolUses: [] },
    { uuid: uuid(6), toolUses: [{ tool_use_id: 'toolu_01Next' }] }
  ])
  // The queued prompt is an attachment of the session's file, stored after the tool result 3.
  noted.learnQueued([{ uuid: uuid(4), after: [uuid(3), uuid(2)] }])
  // Above the prompt the edit's 16 rows, the group's 2 and its own empty top row: the reply's 2
  // rows are under it.
  expect(noted.placeOf(6, `${id(4)}/sent:6`, id(4))).toEqual({ id: 6, target: `${id(4)}/sent:6`, host: id(4), rows: 19, edge: 'first' })
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
