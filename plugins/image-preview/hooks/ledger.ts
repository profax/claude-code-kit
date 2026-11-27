// What the plugin knows of the transcript: each row the engine has drawn, in the transcript's
// order, and where a card that floats over the rows can go.
import type { EventOf } from 'claude-code'

import { idsIn } from './tokens'
import type { Shown } from '../types'

type RenderOf<C extends string> = Extract<EventOf['ui.render'], { component: C, surface: 'terminal' }>

/** The transcript rows: a card floats over the rows above the end of one of them. */
export type Row = RenderOf<'UserMessage' | 'AssistantMessage' | 'ToolUse' | 'ToolResult' | 'ToolGroup' | 'CommandOutput' | 'TurnDuration' | 'InfoNotice'>
type OnScreen = NonNullable<Row['props']['onScreen']>

/**
 * A transcript row: what it is, when it was first drawn and how many rows had been first drawn by
 * its latest drawing, whether it came in the batch a session starts with, which of its rows are on
 * screen, and the text of a composer prompt with `[Image #N]` in it.
 */
type Noted = { component: Row['component']; seen: number; drawnAt: number; isBatch: boolean; onScreen: OnScreen | null | undefined; text?: string }

// Below the transcript the screen holds the band, the prompt box and its hints; above the first
// row, the logo.
const BOTTOM_ROWS = 7
const HEADER_ROWS = 4
const MIN_CARD_ROWS = 6

export class Ledger {
  /** Every transcript row drawn, by requestId. */
  readonly rows = new Map<string, Noted>()
  seenRows = 0
  /** The module loads when a session starts or on a reload, and the engine draws every row at once. */
  isBatching = true
  /** Counts every change of what is on screen: a card closes once its label may have left the pointer. */
  moves = 0
  /** The screen's height; a guess until the engine first says. */
  screenRows = 40
  #order: Map<string, number> | undefined
  #orderSeen = -1

  /** Forgets every row: another session's transcript is drawn. */
  clear () {
    this.rows.clear()
    this.#order = undefined
    this.#orderSeen = -1
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
      this.rows.set(e.requestId, { component: e.component, seen, drawnAt: this.seenRows, isBatch: this.isBatching, onScreen, ...(text !== undefined && { text }) })
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
   * (`placeholder`, replaced by the very next row) and a tool group until its turn ends
   * (`collapsed-toolu_…`). The engine never draws a replaced row again, so its last place on screen
   * would inflate the count of lines for good.
   */
  isReplaced (requestId: string, row: Noted) {
    if (requestId === 'placeholder') return this.seenRows > row.drawnAt
    if (!requestId.startsWith('collapsed-toolu_')) return false
    for (const other of this.rows.values()) if (other.component === 'TurnDuration' && other.seen >= row.drawnAt) return true
    return false
  }

  /**
   * The rows in the transcript's order. A row drawn as the session goes is where it was drawn. The
   * batch a session starts with, or a reload, comes in two passes, the prompts apart from the rest:
   * each prompt is put at the start of its turn, after the duration row of the turn before, the last
   * prompt with the last turn.
   */
  order () {
    if (this.#order && this.#orderSeen === this.seenRows) return this.#order
    const bySeen = (a: [string, Noted], b: [string, Noted]) => a[1].seen - b[1].seen
    const batch = [...this.rows].filter(([, row]) => row.isBatch).sort(bySeen)
    const notices = batch.filter(([, row]) => row.component === 'InfoNotice')
    const prompts = batch.filter(([, row]) => row.component === 'UserMessage')
    const others = batch.filter(([, row]) => row.component !== 'InfoNotice' && row.component !== 'UserMessage')
    const starts = [0, ...others.flatMap(([, row], i) => (row.component === 'TurnDuration' && i + 1 < others.length ? [i + 1] : []))]
    const before = new Map<number, string[]>()
    prompts.forEach(([id], i) => {
      const at = starts[Math.max(0, starts.length - (prompts.length - i))]!
      before.set(at, [...(before.get(at) ?? []), id])
    })
    const ordered = [...notices.map(([id]) => id), ...others.flatMap(([id], i) => [...(before.get(i) ?? []), id])]
    if (others.length === 0) ordered.push(...prompts.map(([id]) => id))
    const order = new Map(ordered.map((id, i) => [id, i]))
    for (const [id, row] of this.rows) if (!row.isBatch) order.set(id, ordered.length + row.seen)
    this.#order = order
    this.#orderSeen = this.seenRows
    return order
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
    const top = showing[0]?.[1]
    // A row off screen, or a first row that is cut, means the transcript fills the screen.
    const isFull = top !== undefined && (top.onScreen.first > 0 || [...this.rows.values()].some(row => row.onScreen === null))
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
    const above = message.first > 0 ? 0 : Math.min(room, count(showing.slice(0, at)) + (isFull ? 0 : HEADER_ROWS) + 1)
    const under = Math.min(room, count(showing.slice(at + 1)))
    if (Math.max(above, under) < MIN_CARD_ROWS) return null
    return above >= under
      ? { id, target, host: prompt, rows: above, edge: 'first' }
      : { id, target, host: lowest![0], rows: under, edge: 'last' }
  }
}
