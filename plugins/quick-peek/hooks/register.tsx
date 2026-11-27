// The paths in a reply become links: under the pointer the terminal shows a card by the path (name,
// size, age, and for code its first lines), a click shows the path in the file manager, and with
// Alt opens it, unless it is a program or a script. Terminal only. Based on quick-peek from
// better-claude (MIT, ../LICENSE), without its windows.
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import { isRunnable } from './code'
import { widthOf, wrap } from './markdown'
import type { Row } from './markdown'
import { nameOf } from './paths'
import { forgetPlans, planOf, statOf } from './plan'
import type { DrawnItem, Plan, Target } from './plan'
import { Ledger, TRANSCRIPT } from './ledger'
import type { Place, Spot, Transcript } from './ledger'
import { forgetSystem, show } from './system'

type Engine = EngineInterface
type Ui = Elements['terminal']
type Message = Extract<Transcript, { component: 'AssistantMessage' }>

const BULLET = '●'
const BULLET_COLUMNS = 2
const CARD_COLUMNS = 100

// What the plugin knows of the transcript rows, and the replies with links: where their links are,
// how far off the count of lines above them may be, and where their cards stand now.
const ledger = new Ledger()
const linked = new Map<string, { spots: Spot[]; slack: number; placed: string; cards: Card[]; copied: string }>()
// The hover group of each card, short: a group's name holds 64 characters at most.
const scopes = new Map<string, string>()

// What the debug log has been told already: a failure that stays would be written at every
// drawing of a reply. A hundred distinct ones are plenty to go on.
const logged = new Set<string>()

/** Puts `text` in the debug log, the first time only. */
function logOnce ($: Engine, text: string) {
  if (logged.has(text) || logged.size >= 100) return
  logged.add(text)
  $.ui.log(text, { to: 'debug' })
}

function forget () {
  ledger.clear()
  linked.clear()
  scopes.clear()
}

const sizeOf = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`

const ago = (ms: number) => {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
  const [value, unit] = seconds < 60 ? [seconds, 's'] : seconds < 3600 ? [Math.round(seconds / 60), 'm'] : seconds < 86400 ? [Math.round(seconds / 3600), 'h'] : [Math.round(seconds / 86400), 'd']
  return `${value}${unit} ago`
}

function cardOf (target: Target) {
  const name = nameOf(target.path) || target.path
  const what = target.stat.kind === 'dir' ? 'folder' : sizeOf(target.stat.size)
  return ` ${name} · ${what} · ${ago(target.stat.mtimeMs)} · click: show in file manager `
}

const placedOf = (requestId: string, spots: Spot[], slack: number) => JSON.stringify(spots.map(spot => ledger.placeOf(requestId, spot, slack)))

/**
 * A row has moved: the replies whose cards now belong elsewhere are drawn again. The engine does
 * not otherwise redraw a reply that has not itself changed, while the room above it shrinks as it
 * is pushed up.
 */
function follow ($: Engine, requestId: string) {
  for (const [id, card] of linked) {
    if (id === requestId || (placedOf(id, card.spots, card.slack) === card.placed && reachOf(id) === card.copied)) continue
    $.ui.invalidate('ui.render')
    return
  }
}

const reachOf = (requestId: string) => JSON.stringify(ledger.after(requestId))

/**
 * The cards that reach over the row `requestId`, drawn again by it: a row paints over every card
 * drawn before it, so the copy the latest row draws lies over all the text in its place. The
 * reply's own lines under a path count as such a row. Each copy stands against the row's foot.
 */
function copiesIn (ui: Ui, requestId: string) {
  const copies: RenderElement[] = []
  for (const [id, reply] of linked) {
    const foot = id === requestId ? { rows: Infinity, foot: 0 } : ledger.after(id).find(row => row.id === requestId)
    if (!foot) continue
    for (const card of reply.cards) {
      if (!card.isExact) continue
      // From the path's line: the row's foot, and its top (for the reply itself, the line under the path).
      const bottom = card.below + 1 + foot.foot
      const top = id === requestId ? 1 : bottom - foot.rows
      if (card.top >= bottom || card.top + card.rows <= top) continue
      copies.push(cardBox(ui, card, { bottom: bottom - card.top - card.rows, left: card.left }))
    }
  }
  return copies
}

/**
 * The count of a reply's lines as it is drawn: the line being drawn, at the least; where a link's
 * card goes; and every link in order.
 */
type Layout = { requestId: string; row: number; x: number; place: (spot: Spot) => Place; spots: Spot[]; cards: Card[] }
/**
 * A card as a row drawn after its path draws it again: where it stands against the path's line
 * (`top`, `rows`), its column from the reply's left edge, and how many lines of the reply are
 * under the path's line, which is known only when no Markdown block of the engine's follows it.
 */
type Card = { scope: string; top: number; rows: number; left: number; width: number; title: string; source?: string; first: number; path: string; line: number; below: number; isExact: boolean }

/** `text` with spaces after it up to `width` cells. */
const padded = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - widthOf(text)))

/**
 * A file's lines from `first` on, numbered, every row written to `width`: the card lies over the
 * transcript, which shows through each cell left unwritten. The numbers are drawn here, not by
 * `Code`, to know how wide they are.
 */
function numbered ({ Box, Code, Text }: Ui, source: string, first: number, width: number, path: string) {
  const lines = source.split('\n')
  const digits = String(first + lines.length - 1).length
  return (
    <Box flexDirection="row">
      <Text dimColor>{lines.map((_, i) => `${String(first + i).padStart(digits)} `).join('\n')}</Text>
      <Code source={lines.map(line => padded(line, width - digits - 1)).join('\n')} path={path} wrap="truncate-end" />
    </Box>
  )
}

/** The hover group of one part of one link of a reply. */
function scopeOf (requestId: string, link: number, part: number) {
  const key = `${requestId}:${link}:${part}`
  let scope = scopes.get(key)
  if (scope === undefined) scopes.set(key, (scope = `card${scopes.size}`))
  return scope
}

/**
 * A card at `at` against its parent: its title on the theme's subtle fill, and a file's lines on the
 * fill of a prompt, every cell written. Shown while any member of its hover group is under the
 * pointer.
 */
function cardBox (ui: Ui, card: Card, at: { top?: number; bottom?: number; left: number }) {
  const { Box, Text } = ui
  return (
    <Box position="absolute" {...at} width={card.width} flexDirection="column" backgroundColor="userMessageBackground" display="none" hover={{ display: 'flex', scope: card.scope }}>
      <Text color="text" backgroundColor="subtle" wrap="truncate-end">{padded(card.title, card.width)}</Text>
      {card.source !== undefined && numbered(ui, card.source, card.first, card.width, card.path)}
    </Box>
  )
}

/** A paragraph's rows at `width`: text in its own style, each part of a path a `Client` of its own. */
function drawRows (ui: Ui, rows: Row[], width: number, targets: Target[], parts: Map<number, number>, layout: Layout) {
  const { Box, Client, Link, Text } = ui
  return rows.map(row => {
    const above = layout.row++
    let column = 0
    return (
      <Box flexDirection="row">
        {row.length === 0 && <Text> </Text>}
        {row.map(run => {
          const at = column
          column += widthOf(run.text)
          const { bold, italic, strike, code, href } = run.style
          if (run.link === undefined) {
            const style = { bold, italic, strikethrough: strike, ...(code && { color: 'permission' }) }
            return href === undefined ? <Text {...style}>{run.text}</Text> : <Text {...style}><Link href={href}>{run.text}</Link></Text>
          }
          const part = parts.get(run.link) ?? 0
          parts.set(run.link, part + 1)
          const target = targets[run.link]!
          const props = { label: run.text, path: target.path, ...(target.line !== undefined && { line: target.line }), ...(bold && { bold }), ...(italic && { italic }), ...(strike && { strike }) }
          // The terminal opens the card itself while the pointer is on the path, moved left far
          // enough to end inside the reply. A card that does not fit the screen it shifts whole,
          // onto the path itself: so `placeOf` picks where the card goes.
          const card = cardOf(target)
          const excerpt = target.code
          const spot = { above, lines: excerpt?.rows ?? 0 }
          layout.spots.push(spot)
          const place = layout.place(spot)
          const source = excerpt && place.lines > 0 ? excerpt.source.split('\n').slice(0, place.lines).join('\n') : undefined
          const cardWidth = Math.min(excerpt ? Math.max(widthOf(card), CARD_COLUMNS) : widthOf(card), width)
          const left = Math.max(-at, Math.min(0, width - at - cardWidth))
          const scope = scopeOf(layout.requestId, run.link, part)
          const drawn: Card = {
            scope, top: place.top, rows: 1 + (source === undefined ? 0 : source.split('\n').length), left: layout.x + at + left, width: cardWidth,
            title: card, ...(source !== undefined && { source }), first: excerpt?.first ?? 1, path: target.path, line: above, below: 0, isExact: true
          }
          layout.cards.push(drawn)
          return (
            <Box key={`card:${run.link}:${part}`} hover={{ scope }}>
              <Client key={`path:${run.link}:${part}`} module="./link.tsx" props={props} />
              {cardBox(ui, drawn, { top: place.top, left })}
            </Box>
          )
        })}
      </Box>
    )
  })
}

function drawList (ui: Ui, list: DrawnItem[], width: number, targets: Target[], parts: Map<number, number>, layout: Layout): RenderElement[] {
  const { Box, Text } = ui
  return list.map((item, i) => {
    const indent = widthOf(item.marker) + 1
    const marginTop = i > 0 && item.gap > 0 ? 1 : 0
    layout.row += marginTop
    layout.x += indent
    const rows = drawRows(ui, wrap(item.runs, width - indent), width - indent, targets, parts, layout)
    const children = drawList(ui, item.children, width - indent, targets, parts, layout)
    layout.x -= indent
    return (
      <Box flexDirection="row" marginTop={marginTop}>
        <Box minWidth={indent} flexShrink={0}><Text>{item.marker}</Text></Box>
        <Box flexDirection="column" width={width - indent}>
          {rows}
          {children}
        </Box>
      </Box>
    )
  })
}

function drawWith (ui: Ui, e: Message, plan: Plan, layout: Layout) {
  const { Box, Markdown, Text } = ui
  const width = Math.max(10, (e.viewport?.columns ?? 80) - BULLET_COLUMNS)
  const parts = new Map<number, number>()
  return (
    <Box flexDirection="row">
      <Box minWidth={BULLET_COLUMNS} flexShrink={0}>{e.props.isFirstOfReply && <Text color="text">{BULLET}</Text>}</Box>
      <Box flexDirection="column" width={width}>
        {plan.parts.map((part, i) => {
          const marginTop = i > 0 && part.gap > 0 ? 1 : 0
          layout.row += marginTop
          if (part.kind === 'markdown') {
            layout.row++
            for (const card of layout.cards) card.isExact = false
            return <Box marginTop={marginTop}><Markdown text={part.text} /></Box>
          }
          const drawn = part.kind === 'paragraph' ? drawRows(ui, wrap(part.runs, width), width, plan.targets, parts, layout) : drawList(ui, part.items, width, plan.targets, parts, layout)
          return <Box flexDirection="column" marginTop={marginTop}>{drawn}</Box>
        })}
      </Box>
    </Box>
  )
}

/**
 * A reply is drawn twice: once to count its lines, then with the cards in their places. Lines on
 * screen beyond the count were added by the engine's Markdown, and where they are is not known.
 */
function draw (ui: Ui, e: Message, plan: Plan) {
  const counted: Layout = { requestId: e.requestId, row: 0, x: BULLET_COLUMNS, place: spot => ({ top: -1 - spot.lines, lines: spot.lines }), spots: [], cards: [] }
  drawWith(ui, e, plan, counted)
  const slack = Math.max(0, (e.props.onScreen?.of ?? 0) - counted.row)
  const layout: Layout = { requestId: e.requestId, row: 0, x: BULLET_COLUMNS, place: spot => ledger.placeOf(e.requestId, spot, slack), spots: [], cards: [] }
  const drawn = drawWith(ui, e, plan, layout)
  for (const card of layout.cards) card.below = layout.row - 1 - card.line
  linked.set(e.requestId, { spots: layout.spots, slack, placed: placedOf(e.requestId, layout.spots, slack), cards: layout.cards, copied: reachOf(e.requestId) })
  return drawn
}

/** A transcript row: a reply the plugin can read with its paths as links, any other row the engine's. */
async function drawRow ($: Engine, e: Transcript, next: (e: Transcript) => Promise<RenderElement>) {
  if (e.component !== 'AssistantMessage' || e.props.isSummary) return next(e)
  // A reply the plugin can't read is the engine's to draw.
  const plan = await planOf($, e.props.text).catch(error => {
    logOnce($, `reading a reply failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  })
  if (!plan) {
    linked.delete(e.requestId)
    return next(e)
  }
  const drawn = await next(e)
  return swap(drawn, draw($.ui.resolve(e), e, plan))
}

/** The tree from `next` with the engine's node replaced by `mine`: what other plugins drew around it stays. */
function swap (drawn: RenderElement, mine: RenderElement): RenderElement {
  let isSwapped = false
  const walk = (node: unknown): unknown => {
    if (isSwapped || node === null || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(walk)
    const element = node as { type?: unknown; children?: unknown[] }
    if (element.type === 'engine') {
      isSwapped = true
      return mine
    }
    return Array.isArray(element.children) ? { ...element, children: element.children.map(walk) } : node
  }
  const out = walk(drawn) as RenderElement
  return isSwapped ? out : mine
}

/** Shows the path in the file manager, or with Alt opens it, unless it is a program or a script. */
async function reveal ($: Engine, path: string, isAlt: boolean) {
  // A program or a script is shown, not run: a reply may name one Claude has not been asked for.
  const isOpening = isAlt && !isRunnable(path, (await statOf($, path))?.kind)
  await show($, path, !isOpening)
}

export const register: Register = (on) => {
  // After /clear or a change of session the transcript is drawn anew, and the rows that were on
  // screen do not come back.
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    forget()
    return result
  })

  on('session.start', async ($, e, next) => {
    forget()
    forgetSystem()
    const result = await next(e)
    forgetPlans()
    return result
  })

  // Prompts drawn after the first one is sent are drawn by the engine in their place.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    ledger.isBatching = false
    return result
  }).catch(($, e, next) => next(e))

  on('ui.message', async ($, e, next) => {
    const result = await next(e)
    if (!e.element.startsWith('path:')) return result
    const data = e.data as { path?: unknown; isClicked?: unknown; isAlt?: unknown } | null
    if (typeof data?.path === 'string' && data.isClicked === true) void reveal($, data.path, data.isAlt === true)
    return result
  })

  // Off fullscreen the terminal reports no pointer: the engine draws the reply as it is. The other
  // transcript rows are only noted: they tell how much room there is above a link and below it.
  on('ui.render', { component: [...TRANSCRIPT] }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.viewport?.isFullscreen !== true) return next(e)
    if (ledger.note(e)) follow($, e.requestId)
    const ui = $.ui.resolve(e)
    const drawn = await drawRow($, e, next)
    const copies = copiesIn(ui, e.requestId)
    if (copies.length === 0) return drawn
    const { Box } = ui
    return <Box flexDirection="column">{drawn}{copies}</Box>
  })
}
