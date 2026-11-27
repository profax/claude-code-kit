// What the plugin knows of the transcript: each row the engine has drawn, and how much room there
// is around a link in a reply for its card.
import type { EventOf } from 'claude-code'

import { BOTTOM_ROWS, HEADER_ROWS } from './screen'

/** The transcript rows the plugin draws or notes. */
export const TRANSCRIPT = ['UserMessage', 'AssistantMessage', 'ToolUse', 'ToolResult', 'ToolGroup', 'CommandOutput', 'TurnDuration', 'InfoNotice'] as const
export type Transcript = Extract<EventOf['ui.render'], { component: (typeof TRANSCRIPT)[number], surface: 'terminal' }>
type OnScreen = NonNullable<Transcript['props']['onScreen']>

/**
 * A transcript row: its number among the rows in the order first drawn, how many rows had been
 * first drawn by its latest drawing, whether it is a prompt from the batch a session starts with,
 * and which of its lines are on screen.
 */
type Seen = { component: Transcript['component']; seen: number; drawnAt: number; isBatchPrompt: boolean; onScreen: OnScreen | null | undefined }
/**
 * Where a path's card goes: how many lines its top is from the path's line (negative is above the
 * path) and how many of the file's lines it holds.
 */
export type Place = { top: number; lines: number }
/**
 * A link in a reply: how many of the reply's lines are above it at the least, and how many of the
 * file's lines its card wants. The plugin cannot tell how tall the engine's Markdown is and counts
 * each of its blocks as one line.
 */
export type Spot = { above: number; lines: number }

// Below the last transcript row, at the least: the prompt box with its hints.
const MIN_BOTTOM_ROWS = 4

export class Ledger {
  /** Every transcript row drawn, by requestId. */
  readonly rows = new Map<string, Seen>()
  seenRows = 0
  /** The screen's height; a guess until the engine first says. */
  screenRows = 40
  /**
   * The module loads when a session starts or on a reload, and the engine draws every row at once.
   * It draws the prompts of such a batch apart from the rest, so their place among the rows is not
   * known.
   */
  isBatching = true

  /** Forgets every row: the transcript is drawn anew. */
  clear () {
    this.rows.clear()
    this.isBatching = true
  }

  /** Notes a transcript row before the first await, so in the transcript's order; true if it has moved. */
  note (e: Transcript) {
    if (e.viewport) this.screenRows = e.viewport.rows
    const onScreen = e.props.onScreen
    const row = this.rows.get(e.requestId)
    if (!row) {
      this.rows.set(e.requestId, { component: e.component, seen: this.seenRows++, drawnAt: this.seenRows, isBatchPrompt: this.isBatching && e.component === 'UserMessage', onScreen })
      return true
    }
    row.drawnAt = this.seenRows
    if (row.onScreen?.first === onScreen?.first && row.onScreen?.last === onScreen?.last && row.onScreen?.of === onScreen?.of && (row.onScreen === null) === (onScreen === null)) return false
    row.onScreen = onScreen
    return true
  }

  /**
   * A row the engine drew under a temporary id and then replaced: a prompt before it is stored
   * (`placeholder`, replaced by the very next row) and a new tool group (`collapsed-toolu_…`,
   * replaced by the next tool group row drawn or at the end of its turn). Its last place on screen
   * would inflate the count of lines.
   */
  isReplaced (requestId: string, row: Seen) {
    if (requestId === 'placeholder') return this.seenRows > row.drawnAt
    if (!requestId.startsWith('collapsed-toolu_')) return false
    for (const other of this.rows.values()) {
      if ((other.component === 'TurnDuration' || other.component === 'ToolGroup') && other.seen >= row.drawnAt) return true
    }
    return false
  }

  /**
   * How many screen lines there are at the least above the link's line and below it, or undefined
   * when the engine does not say where the reply is. A row that cannot be put above or below the
   * reply for certain counts on neither side: undercounting moves the card to the other side or
   * shortens it, overcounting would lay it over the path.
   */
  roomOf (requestId: string, above: number, slack: number) {
    const me = this.rows.get(requestId)
    const at = me?.onScreen
    if (!me || !at) return undefined
    let before = 0
    let after = 0
    let all = 0
    let isFull = false
    for (const [id, row] of this.rows) {
      const shown = row.onScreen
      if (shown === undefined || this.isReplaced(id, row)) continue
      // A row off screen, or one cut at the top, means the transcript fills the screen and sits at
      // its foot.
      if (shown === null || shown.first > 0) isFull = true
      if (shown === null) continue
      const rows = shown.last - shown.first + 1
      all += rows
      if (id === requestId || row.isBatchPrompt) continue
      // A row cut at the top is the top one on screen and a row cut at the bottom the lowest one,
      // whenever they were drawn.
      if (shown.first > 0 || (shown.last === shown.of - 1 && row.seen < me.seen)) before += rows
      else after += rows
    }
    // More lines than the screen holds: the engine has dropped some noted rows without saying so (a
    // rewind), and no row but the reply's own can be trusted.
    if (all + (isFull ? 0 : HEADER_ROWS) > this.screenRows - MIN_BOTTOM_ROWS) {
      before = 0
      after = 0
      isFull = true
    }
    // A short transcript sits at the top, with nothing under it down to the prompt box; one line is
    // kept spare.
    const free = isFull ? 0 : Math.max(0, this.screenRows - BOTTOM_ROWS - HEADER_ROWS - all - 1)
    // Never over the logo: Claude Code does not draw it again, and what a card leaves there stays.
    const up = Math.max(0, above - at.first) + (at.first > 0 ? 0 : before)
    const down = Math.max(0, at.last - above - slack) + (at.last < at.of - 1 ? 0 : after + free)
    // Rows drawn after the reply, and the reply's own lines below the path, paint over a card under
    // the path: the only clear room there is below the transcript's last line.
    const under = { top: at.of - above + after, rows: Math.max(0, free - slack) }
    return { up, down, under }
  }

  /**
   * The card goes above the path, and where it does not fit there, below: under the end of the
   * transcript, or with no room there right under the path, where the rows drawn after the path draw
   * it again over themselves (`copiesIn`). Fitting on neither side, it takes the larger one, its
   * heading and as many of the file's lines as fit. Above the path when the reply's place on screen
   * is not known.
   */
  placeOf (requestId: string, spot: Spot, slack: number): Place {
    const rows = 1 + spot.lines
    const room = this.roomOf(requestId, spot.above, slack)
    if (!room || room.up >= rows) return { top: -rows, lines: spot.lines }
    if (room.under.rows >= rows) return { top: room.under.top, lines: spot.lines }
    if (room.down >= rows) return { top: 1, lines: spot.lines }
    // With no room above, the row above may be the logo's.
    const isUp = room.up > 0 && room.up >= room.down
    const held = Math.max(1, isUp ? room.up : room.down)
    return { top: isUp ? -held : 1, lines: held - 1 }
  }

  /**
   * The rows drawn after a reply, each with how many lines there are from the reply's foot to the
   * row's own foot: the rows one under another down the screen, none off it and none cut at its top.
   * Empty while the reply's foot is not on screen.
   */
  after (requestId: string) {
    const me = this.rows.get(requestId)
    const reach: { id: string; rows: number; foot: number }[] = []
    if (!me?.onScreen || me.onScreen.last !== me.onScreen.of - 1) return reach
    let foot = 0
    for (const [id, row] of this.rows) {
      if (row.seen <= me.seen || row.isBatchPrompt || row.onScreen === undefined || this.isReplaced(id, row)) continue
      if (row.onScreen === null || row.onScreen.first > 0) break
      foot += row.onScreen.of
      reach.push({ id, rows: row.onScreen.of, foot })
    }
    return reach
  }
}
