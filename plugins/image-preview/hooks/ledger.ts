// What the plugin knows of the transcript: each row the engine has drawn, in the transcript's
// order, and where a card that floats over the rows can go.
import type { EventOf } from 'claude-code'

import { BOTTOM_ROWS } from './screen'
import { idsIn } from './tokens'
import type { Shown } from '../types'

type RenderOf<C extends string> = Extract<EventOf['ui.render'], { component: C, surface: 'terminal' }>

/** The transcript rows: a card floats over the rows above the end of one of them. */
export const TRANSCRIPT = ['UserMessage', 'AssistantMessage', 'ToolUse', 'ToolResult', 'ToolGroup', 'CommandOutput', 'TurnDuration', 'InfoNotice'] as const
export type Row = RenderOf<(typeof TRANSCRIPT)[number]>
type OnScreen = NonNullable<Row['props']['onScreen']>

/**
 * A transcript row: what it is, when it was first drawn and how many rows had been first drawn by
 * its latest drawing, which of its rows are on screen, and the text of a composer prompt with
 * `[Image #N]` in it.
 */
type Noted = { component: Row['component']; seen: number; drawnAt: number; onScreen: OnScreen | null | undefined; text?: string }

/**
 * The message a row draws, as the transcript keeps it: a message row's id is the message's uuid
 * with its last group zeroed (Claude Code 2.1.332), a tool group's that of a message in it after
 * `collapsed-`, a tool row's the call's id.
 */
const messageOf = (requestId: string) => {
  const id = requestId.startsWith('collapsed-') ? requestId.slice('collapsed-'.length) : requestId
  return id.startsWith('toolu_') ? id : id.slice(0, 23)
}

/**
 * A message as a ranged read of the transcript returns it (Claude Code 2.1.332): with its uuid and
 * its tool calls. Claude Code 2.1.325 refuses such a read and has no `uuid` in its types.
 */
export type Placed = { uuid?: string; toolUses: readonly { tool_use_id: string }[] }

const MIN_CARD_ROWS = 6

export class Ledger {
  /** Every transcript row drawn, by requestId. */
  readonly rows = new Map<string, Noted>()
  seenRows = 0
  /** Set when a row was drawn that no message read so far places: `learn` the newer messages. */
  isBehind = false
  /** Counts every change of what is on screen: a card closes once its label may have left the pointer. */
  moves = 0
  /** The screen's height; a guess until the engine first says. */
  screenRows = 40
  /** Where each message stands in the transcript, by `messageOf`; the uuid of the last one read. */
  #places = new Map<string, number>()
  #read = 0
  #lastRead: string | undefined
  #order: Map<string, number> | undefined

  /** Forgets every row: another session's transcript is drawn. */
  clear () {
    this.rows.clear()
    this.forget()
    this.moves++
  }

  /**
   * Notes a transcript row before the first await, so in the transcript's order. True when a prompt
   * with labels went out of the viewport or came back: the row under its list draws its chips
   * meanwhile, and the engine would not draw that row again if it did not move.
   */
  note (e: Row) {
    if (e.viewport && e.viewport.rows !== this.screenRows) {
      this.screenRows = e.viewport.rows
      this.moves++
    }
    const onScreen = e.props.onScreen
    const row = this.rows.get(e.requestId)
    if (!row) {
      const seen = this.seenRows++
      const text = e.component === 'UserMessage' && e.props.origin.kind === 'composer' && idsIn(e.props.text).length > 0 ? e.props.text : undefined
      this.rows.set(e.requestId, { component: e.component, seen, drawnAt: this.seenRows, onScreen, ...(text !== undefined && { text }) })
      this.#order = undefined
      if (!this.#places.has(messageOf(e.requestId))) this.isBehind = true
      this.moves++
      return false
    }
    row.drawnAt = this.seenRows
    const isHidden = row.onScreen === null
    if (row.onScreen?.first !== onScreen?.first || row.onScreen?.last !== onScreen?.last || row.onScreen?.of !== onScreen?.of || isHidden !== (onScreen === null)) {
      row.onScreen = onScreen
      this.moves++
    }
    return row.text !== undefined && isHidden !== (onScreen === null)
  }

  /**
   * A row the engine drew under a temporary id and then replaced: a prompt before it is stored
   * (`placeholder`, replaced by the very next row) and a new tool group (`collapsed-toolu_…`,
   * replaced by the next tool group row drawn or at the end of its turn). The engine never draws a
   * replaced row again, so its last place on screen would inflate the count of lines for good.
   */
  isReplaced (requestId: string, row: Noted) {
    if (requestId === 'placeholder') return this.seenRows > row.drawnAt
    if (!requestId.startsWith('collapsed-toolu_')) return false
    for (const other of this.rows.values()) {
      if ((other.component === 'TurnDuration' || other.component === 'ToolGroup') && other.seen >= row.drawnAt) return true
    }
    return false
  }

  /** The uuid a read of the messages newer than those learnt starts after; none, read the newest. */
  get lastRead () {
    return this.#lastRead
  }

  /** Learns where messages stand, read newest last: all the transcript has, or those after `lastRead`. */
  learn (messages: readonly Placed[]) {
    for (const message of messages) {
      if (message.uuid === undefined) continue
      const at = this.#read++
      this.#places.set(messageOf(message.uuid), at)
      for (const { tool_use_id } of message.toolUses) if (!this.#places.has(tool_use_id)) this.#places.set(tool_use_id, at)
      this.#lastRead = message.uuid
    }
    this.#order = undefined
  }

  /** Forgets the messages learnt: the transcript was cut (compacted) or another one is drawn. */
  forget () {
    this.#places.clear()
    this.#read = 0
    this.#lastRead = undefined
    this.#order = undefined
  }

  /**
   * The rows in the transcript's order, by the messages learnt. The engine draws a session it opens,
   * or a reload, a block at a time, the newest first, each block in order, and more blocks as the
   * transcript scrolls back: so a row no message places (a turn's duration, a prompt queued while a
   * turn ran, any row before the messages are read) comes right after the row drawn before it. One
   * that opens a block stands at the end of the block drawn before.
   */
  order () {
    if (this.#order) return this.#order
    let place = -1
    // The rows come in the order first drawn.
    const placed = [...this.rows].map(([id, row]) => {
      place = this.#places.get(messageOf(id)) ?? place
      return { id, place, seen: row.seen }
    })
    placed.sort((a, b) => a.place - b.place || a.seen - b.seen)
    this.#order = new Map(placed.map(({ id }, i) => [id, i]))
    return this.#order
  }

  /**
   * The composer prompt with labels right above transcript row `requestId`, while the engine draws
   * that prompt outside the viewport (`onScreen` null). Its rows may be gone under the top row while
   * the list of its images, drawn by the engine between it and this row, still shows: the engine
   * then hit-tests nothing the prompt drew, its chips over the list included.
   */
  hiddenPromptAbove (requestId: string) {
    const order = this.order()
    const mine = order.get(requestId)
    if (mine === undefined) return undefined
    let above: string | undefined
    let aboveAt = -Infinity
    for (const [id, at] of order) {
      const row = this.rows.get(id)
      if (at < mine && at > aboveAt && row && !this.isReplaced(id, row)) {
        above = id
        aboveAt = at
      }
    }
    const row = above === undefined ? undefined : this.rows.get(above)
    return row?.text !== undefined && row.onScreen === null ? above : undefined
  }

  /**
   * Where the card of image `id`, opened by `target`, goes over the transcript. From a band chip
   * (no `prompt`): in the band, above the prompt box, where it covers no text. From a sent prompt it
   * floats, never over the label that opened it and only over rows drawn before the one it stands on
   * (one drawn later paints over it): over the rows above the prompt or under its list, whichever
   * has more room, and under the list when the prompt itself is off screen; nowhere when it fits
   * neither. Only known rows count, so the count is never too high.
   */
  placeOf (id: number, target: string, prompt?: string): Shown | null {
    if (prompt === undefined) return { id, target, host: null, rows: 0, edge: 'last' }
    const order = this.order()
    const showing = [...this.rows]
      .filter(([requestId, row]) => !!row.onScreen && !this.isReplaced(requestId, row))
      .map(([id, row]) => [id, { order: order.get(id)!, onScreen: row.onScreen! }] as const)
    // A row first drawn late (scrolled into view) stands where the screen's edge cuts it.
    const placeOn = ({ order, onScreen }: { order: number; onScreen: OnScreen }) =>
      onScreen.first > 0 ? -Infinity : onScreen.last < onScreen.of - 1 ? Infinity : order
    showing.sort((a, b) => placeOn(a[1]) - placeOn(b[1]) || a[1].order - b[1].order)
    const room = this.screenRows - BOTTOM_ROWS
    const lowest = showing.at(-1)
    const count = (list: typeof showing) => list.reduce((sum, [, row]) => sum + row.onScreen.last - row.onScreen.first + 1, 0)

    const at = showing.findIndex(([requestId]) => requestId === prompt)
    if (at === -1) {
      // A hidden prompt whose list still shows (`hiddenPromptAbove`) has its list at the top: the
      // card goes under the list, over the rows that follow the prompt.
      const from = order.get(prompt)
      if (from === undefined || this.rows.get(prompt)?.onScreen !== null) return null
      const under = Math.min(room, count(showing.filter(([, row]) => row.order > from)))
      return under < MIN_CARD_ROWS ? null : { id, target, host: lowest![0], rows: under, edge: 'last' }
    }
    const message = showing[at]![1].onScreen
    // Never over the logo: Claude Code does not draw it again, and what a card leaves there stays.
  const above = message.first > 0 ? 0 : Math.min(room, count(showing.slice(0, at)) + 1)
    const under = Math.min(room, count(showing.slice(at + 1)))
    if (Math.max(above, under) < MIN_CARD_ROWS) return null
    return above >= under
      ? { id, target, host: prompt, rows: above, edge: 'first' }
      : { id, target, host: lowest![0], rows: under, edge: 'last' }
  }
}
