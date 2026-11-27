// The paths in a reply become links: under the pointer the terminal shows a card by the path (name,
// size, age, and for code its first lines), a click shows the path in the file manager, and with
// Alt opens it, unless it is a program or a script. Terminal only. Based on quick-peek from better-claude (MIT, ../LICENSE), without
// its windows.
import type { Elements, EngineInterface, EventOf, FsStat, Register, RenderElement } from 'claude-code'

import { excerptOf, isRunnable, isText } from './code'
import type { Excerpt } from './code'
import { blocks, inline, items, markerOf, widthOf, wrap } from './markdown'
import type { Item, Row, Run } from './markdown'
import { lineOf, nameOf, pathOfSpan, pathsIn, resolve } from './paths'

type Engine = EngineInterface
type Ui = Elements['terminal']
const TRANSCRIPT = ['UserMessage', 'AssistantMessage', 'ToolUse', 'ToolResult', 'ToolGroup', 'CommandOutput', 'TurnDuration', 'InfoNotice'] as const
type Transcript = Extract<EventOf['ui.render'], { component: (typeof TRANSCRIPT)[number], surface: 'terminal' }>
type Message = Extract<Transcript, { component: 'AssistantMessage' }>
type OnScreen = NonNullable<Transcript['props']['onScreen']>

/** A path in a reply that leads somewhere: where, what is there, the line it names, the card's lines. */
type Target = { path: string; stat: FsStat; line?: number; code?: Excerpt }
type DrawnItem = { marker: string; runs: Run[]; children: DrawnItem[]; gap: number }
/** A part of a reply: drawn by the engine's Markdown, or by the plugin with its paths as links. */
type Part =
  | { kind: 'markdown'; text: string; gap: number }
  | { kind: 'paragraph'; runs: Run[]; gap: number }
  | { kind: 'list'; items: DrawnItem[]; gap: number }
/** How the plugin draws a reply: its parts, and the paths `Run.link` points into. */
type Plan = { parts: Part[]; targets: Target[] }
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
type Place = { top: number; lines: number }
/**
 * A link in a reply: how many of the reply's lines are above it at the least, and how many of the
 * file's lines its card wants. The plugin cannot tell how tall the engine's Markdown is and counts
 * each of its blocks as one line.
 */
type Spot = { above: number; lines: number }

const BULLET = '●'
const BULLET_COLUMNS = 2
// How long to trust that a path exists or does not, and a reply's plan: a reply is drawn often.
const FOUND_MS = 30_000
const MISSING_MS = 3_000
const PLAN_MS = 10_000
const PLANS = 300
const CODE_BYTES = 1024 * 1024
const CARD_LINES = 8
const CARD_COLUMNS = 100
// Above the first transcript row is the logo; below the last, the prompt box with its hints and the
// status line.
const HEADER_ROWS = 5
const BOTTOM_ROWS = 7
const MIN_BOTTOM_ROWS = 4

const stats = new Map<string, { stat: FsStat | null; at: number }>()
const plans = new Map<string, { plan: Plan | null; at: number }>()
const excerpts = new Map<string, Excerpt | null>()
// The transcript rows by requestId, and the replies with links: where their links are, how far off
// the count of lines above them may be, and where their cards stand now.
const seen = new Map<string, Seen>()
const linked = new Map<string, { spots: Spot[]; slack: number; placed: string }>()
let seenRows = 0
let screenRows = 40
// The module loads when a session starts or on a reload, and the engine draws every row at once.
// It draws the prompts of such a batch apart from the rest, so their place among the rows is not
// known.
let isBatching = true

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
  seen.clear()
  linked.clear()
  isBatching = true
}

async function statOf ($: Engine, path: string) {
  const now = Date.now()
  const known = stats.get(path)
  if (known && now - known.at < (known.stat ? FOUND_MS : MISSING_MS)) return known.stat
  const stat = await $.fs.stat(path).catch(() => null)
  stats.set(path, { stat: stat && stat.kind !== 'other' ? stat : null, at: now })
  return stats.get(path)!.stat
}

/** The card's lines from a code or text file; read again once the file changes. */
async function excerptAt ($: Engine, path: string, stat: FsStat, line: number | undefined) {
  if (!isText(path) || stat.kind !== 'file' || stat.size > CODE_BYTES) return null
  const key = `${path}\n${stat.size}\n${stat.mtimeMs}\n${line ?? 0}`
  const known = excerpts.get(key)
  if (known !== undefined) return known
  const text = await $.fs.read(path).catch(() => undefined)
  const excerpt = typeof text === 'string' ? excerptOf(text, line, CARD_LINES) ?? null : null
  if (excerpts.size >= PLANS) excerpts.delete(excerpts.keys().next().value!)
  excerpts.set(key, excerpt)
  return excerpt
}

/** A run cut at its paths: each path a run of its own, linked to its target. */
function link (run: Run, found: { start: number; end: number; link: number }[]): Run[] {
  const out: Run[] = []
  let at = 0
  for (const { start, end, link } of found) {
    if (start > at) out.push({ text: run.text.slice(at, start), style: run.style })
    out.push({ text: run.text.slice(start, end), style: run.style, link })
    at = end
  }
  if (at < run.text.length) out.push({ text: run.text.slice(at), style: run.style })
  return out
}

/**
 * The plugin draws the paragraphs and lists that hold a path leading somewhere; the engine's Markdown
 * draws the other blocks and what lies between. Null when no path leads anywhere: the engine draws
 * the reply.
 */
async function planOf ($: Engine, text: string): Promise<Plan | null> {
  // A reply names paths from the project's root, or from the folder the shell has moved to: both
  // are tried.
  const cwd = await $.session.cwd()
  const root = await $.session.root().catch(() => cwd)
  const key = `${cwd}\n${root}\n${text}`
  const known = plans.get(key)
  if (known && Date.now() - known.at < PLAN_MS) return known.plan

  // Windows names the home folder in USERPROFILE.
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  type Pending = { run: Run; found: { start: number; end: number; paths: string[]; line?: number }[] }
  const pending: Pending[] = []
  const runsOf = (source: string) =>
    inline(source).map(run => {
      const found: Pending['found'] = []
      if (run.style.href === undefined) {
        const named = run.style.code ? [pathOfSpan(run.text)].flatMap(target => (target ? [{ start: 0, end: run.text.length, target }] : [])) : pathsIn(run.text)
        for (const { start, end, target } of named) {
          const paths = [...new Set([cwd, root].flatMap(base => resolve(target, base, home) ?? []))]
          const line = lineOf(run.text.slice(start, end))
          if (paths.length > 0) found.push({ start, end, paths, ...(line !== undefined && { line }) })
        }
      }
      const entry = { run, found }
      pending.push(entry)
      return entry
    })

  type Drafted = { kind: 'markdown'; text: string; gap: number } | { kind: 'paragraph'; runs: Pending[]; gap: number } | { kind: 'list'; items: DraftItem[]; gap: number }
  type DraftItem = { marker: string; runs: Pending[]; children: DraftItem[]; gap: number }
  const draftItems = (list: Item[], depth: number): DraftItem[] =>
    list.map(item => ({ marker: markerOf(item, depth), runs: runsOf(item.text), children: draftItems(item.children, depth + 1), gap: item.gap }))
  const cut = blocks(text)
  const drafted: Drafted[] = cut.map(block =>
    block.kind === 'paragraph' ? { kind: 'paragraph', runs: runsOf(block.text), gap: block.gap }
      : block.kind === 'list' ? { kind: 'list', items: draftItems(items(block.text), 0), gap: block.gap }
        : { kind: 'markdown', text: block.text, gap: block.gap })

  const paths = [...new Set(pending.flatMap(entry => entry.found.flatMap(found => found.paths)))]
  const found = new Map((await Promise.all(paths.map(async path => [path, await statOf($, path)] as const))).filter(([, stat]) => stat !== null) as [string, FsStat][])
  const targets: Target[] = []
  const finish = (runs: Pending[]) =>
    runs.flatMap(({ run, found: named }) => {
      const kept = named.flatMap(({ paths: candidates, ...entry }) => {
        const path = candidates.find(candidate => found.has(candidate))
        return path === undefined ? [] : [{ ...entry, link: targets.push({ path, stat: found.get(path)!, ...(entry.line !== undefined && { line: entry.line }) }) - 1 }]
      })
      return link(run, kept)
    })
  const linked = (runs: Run[]) => runs.some(run => run.link !== undefined)
  const finishItems = (list: DraftItem[]): DrawnItem[] => list.map(item => ({ marker: item.marker, runs: finish(item.runs), children: finishItems(item.children), gap: item.gap }))
  const anyLinked = (list: DrawnItem[]): boolean => list.some(item => linked(item.runs) || anyLinked(item.children))

  const parts: Part[] = []
  drafted.forEach((draft, i) => {
    let part: Part = { kind: 'markdown', text: cut[i]!.text, gap: draft.gap }
    if (draft.kind === 'paragraph') {
      const runs = finish(draft.runs)
      if (linked(runs)) part = { kind: 'paragraph', runs, gap: draft.gap }
    } else if (draft.kind === 'list') {
      const list = finishItems(draft.items)
      if (anyLinked(list)) part = { kind: 'list', items: list, gap: draft.gap }
    }
    // Neighboring engine blocks go as one Markdown, with the same blank lines between them.
    const last = parts.at(-1)
    if (part.kind === 'markdown' && last?.kind === 'markdown') last.text += '\n'.repeat(part.gap + 1) + part.text
    else parts.push(part)
  })
  await Promise.all(targets.map(async target => {
    const code = await excerptAt($, target.path, target.stat, target.line)
    if (code) target.code = code
  }))
  const plan = targets.length > 0 ? { parts, targets } : null
  if (plans.size >= PLANS) plans.delete(plans.keys().next().value!)
  plans.set(key, { plan, at: Date.now() })
  return plan
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

/** Notes a transcript row before the first await, so in the transcript's order; true if it has moved. */
function note (e: Transcript) {
  if (e.viewport) screenRows = e.viewport.rows
  const onScreen = e.props.onScreen
  const row = seen.get(e.requestId)
  if (!row) {
    seen.set(e.requestId, { component: e.component, seen: seenRows++, drawnAt: seenRows, isBatchPrompt: isBatching && e.component === 'UserMessage', onScreen })
    return true
  }
  row.drawnAt = seenRows
  if (row.onScreen?.first === onScreen?.first && row.onScreen?.last === onScreen?.last && row.onScreen?.of === onScreen?.of && (row.onScreen === null) === (onScreen === null)) return false
  row.onScreen = onScreen
  return true
}

/**
 * A row the engine drew under a temporary id and then replaced: a prompt before it is stored
 * (`placeholder`, replaced by the very next row) and a tool group until its turn ends
 * (`collapsed-toolu_…`). Its last place on screen would inflate the count of lines.
 */
function isReplaced (requestId: string, row: Seen) {
  if (requestId === 'placeholder') return seenRows > row.drawnAt
  if (!requestId.startsWith('collapsed-toolu_')) return false
  for (const other of seen.values()) if (other.component === 'TurnDuration' && other.seen >= row.drawnAt) return true
  return false
}

/**
 * How many screen lines there are at the least above the link's line and below it, or undefined
 * when the engine does not say where the reply is. A row that cannot be put above or below the
 * reply for certain counts on neither side: undercounting moves the card to the other side or
 * shortens it, overcounting would lay it over the path.
 */
function roomOf (requestId: string, above: number, slack: number) {
  const me = seen.get(requestId)
  const at = me?.onScreen
  if (!me || !at) return undefined
  let before = 0
  let after = 0
  let all = 0
  let isFull = false
  for (const [id, row] of seen) {
    const shown = row.onScreen
    if (shown === undefined || isReplaced(id, row)) continue
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
  if (all + (isFull ? 0 : HEADER_ROWS) > screenRows - MIN_BOTTOM_ROWS) {
    before = 0
    after = 0
    isFull = true
  }
  // A short transcript sits at the top, with nothing under it down to the prompt box; one line is
  // kept spare.
  const free = isFull ? 0 : Math.max(0, screenRows - BOTTOM_ROWS - HEADER_ROWS - all - 1)
  const up = Math.max(0, above - at.first) + (at.first > 0 ? 0 : before + (isFull ? 0 : HEADER_ROWS))
  const down = Math.max(0, at.last - above - slack) + (at.last < at.of - 1 ? 0 : after + free)
  // Rows drawn after the reply, and the reply's own lines below the path, paint over a card under
  // the path: the only clear room there is below the transcript's last line.
  const under = { top: at.of - above + after, rows: Math.max(0, free - slack) }
  return { up, down, under }
}

/**
 * The card goes above the path, and where it does not fit there, under the end of the transcript.
 * Fitting in neither, it takes the larger, its heading and as many of the file's lines as fit.
 * Right under the path only with no clear row on either side, since what is drawn there paints
 * over it. Above the path when the reply's place on screen is not known.
 */
function placeOf (requestId: string, spot: Spot, slack: number): Place {
  const rows = 1 + spot.lines
  const room = roomOf(requestId, spot.above, slack)
  if (!room || room.up >= rows) return { top: -rows, lines: spot.lines }
  if (room.under.rows >= rows) return { top: room.under.top, lines: spot.lines }
  if (room.up >= 1 && room.up >= room.under.rows) return { top: -room.up, lines: room.up - 1 }
  if (room.under.rows >= 1) return { top: room.under.top, lines: room.under.rows - 1 }
  return { top: 1, lines: Math.min(spot.lines, Math.max(1, room.down) - 1) }
}

const placedOf = (requestId: string, spots: Spot[], slack: number) => JSON.stringify(spots.map(spot => placeOf(requestId, spot, slack)))

/**
 * A row has moved: the replies whose cards now belong elsewhere are drawn again. The engine does
 * not otherwise redraw a reply that has not itself changed, while the room above it shrinks as it
 * is pushed up.
 */
function follow ($: Engine, requestId: string) {
  for (const [id, card] of linked) {
    if (id === requestId || placedOf(id, card.spots, card.slack) === card.placed) continue
    $.ui.invalidate('ui.render')
    return
  }
}

/**
 * The count of a reply's lines as it is drawn: the line being drawn, at the least; where a link's
 * card goes; and every link in order.
 */
type Layout = { row: number; place: (spot: Spot) => Place; spots: Spot[] }

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
          return (
            <Box key={`card:${run.link}:${part}`}>
              <Client key={`path:${run.link}:${part}`} module="./link.tsx" props={props} />
              <Box position="absolute" top={place.top} left={left} width={cardWidth} flexDirection="column" backgroundColor="userMessageBackground" display="none" hover={{ display: 'flex' }}>
                <Text color="text" backgroundColor="subtle" wrap="truncate-end">{padded(card, cardWidth)}</Text>
                {excerpt && source !== undefined && numbered(ui, source, excerpt.first, cardWidth, target.path)}
              </Box>
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
    const rows = drawRows(ui, wrap(item.runs, width - indent), width - indent, targets, parts, layout)
    const children = drawList(ui, item.children, width - indent, targets, parts, layout)
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
  const counted: Layout = { row: 0, place: spot => ({ top: -1 - spot.lines, lines: spot.lines }), spots: [] }
  drawWith(ui, e, plan, counted)
  const slack = Math.max(0, (e.props.onScreen?.of ?? 0) - counted.row)
  const layout: Layout = { row: 0, place: spot => placeOf(e.requestId, spot, slack), spots: [] }
  const drawn = drawWith(ui, e, plan, layout)
  linked.set(e.requestId, { spots: layout.spots, slack, placed: placedOf(e.requestId, layout.spots, slack) })
  return drawn
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

/**
 * Opens the path or selects it in the file manager: Explorer on Windows and under WSL, Finder on
 * macOS, and on Linux the manager that answers FileManager1 (Nautilus) or, where none does, the
 * path's folder opened.
 */
async function reveal ($: Engine, path: string, isAlt: boolean) {
  // A program or a script is shown, not run: a reply may name one Claude has not been asked for.
  const isOpening = isAlt && !isRunnable(path, (await statOf($, path))?.kind)
  const run = (argv: string[]) => $.process.run(argv).catch(() => undefined)
  // The system is told by `OS`, the distro's name and `uname`: Claude Code 2.1.325 has no
  // `$.session.info()`, and a module that calls it does not load there at all.
  const isWsl = (await $.env.get('WSL_DISTRO_NAME')) !== undefined
  if (isWsl || (await $.env.get('OS')) === 'Windows_NT') {
    const shown = isWsl ? (await run(['wslpath', '-w', path]))?.stdout.trim() : path
    // Explorer takes the path as an argument of its own after `/select,`: quoted in one with it,
    // it opens the Documents folder instead.
    if (shown) await run(isOpening ? ['explorer.exe', shown] : ['explorer.exe', '/select,', shown])
    return
  }
  if ((await run(['uname', '-s']))?.stdout.trim() === 'Darwin') {
    await run(isOpening ? ['open', path] : ['open', '-R', path])
    return
  }
  if (isOpening) {
    await run(['xdg-open', path])
    return
  }
  const uri = `file://${path.split('/').map(encodeURIComponent).join('/')}`
  const shown = await run(['dbus-send', '--session', '--print-reply', '--dest=org.freedesktop.FileManager1', '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1.ShowItems', `array:string:${uri}`, 'string:'])
  if (shown?.exitCode !== 0) await run(['xdg-open', path.slice(0, path.lastIndexOf('/')) || '/'])
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
    const result = await next(e)
    plans.clear()
    stats.clear()
    excerpts.clear()
    return result
  })

  // Prompts drawn after the first one is sent are drawn by the engine in their place.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    isBatching = false
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
    if (note(e)) follow($, e.requestId)
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
  })
}
