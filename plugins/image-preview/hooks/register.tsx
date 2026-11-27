// A pasted image, [Image #N], previewed on hover: above the prompt box while the prompt is being
// written, and on the prompts already sent. Ghostty and kitty draw the picture itself, on Windows
// and under WSL a Windows window by the pointer shows it, and other terminals paint colored cells.
// Based on image-preview from better-claude (MIT, ../LICENSE), without its macOS and Tk windows.
import { atom, memberOf, read, update } from 'claude-code'
import type { Elements, EngineInterface, EventOf, Register, RenderElement } from 'claude-code'

import { fit, parseBmp, toCells } from './pixels'
import { readerCommand, windowCommand } from './window'
import type { Pixels } from './pixels'
import type { Picture, Shown } from '../types'

type Engine = EngineInterface
type RenderOf<C extends string> = Extract<EventOf['ui.render'], { component: C, surface: 'terminal' }>
type Bounds = { columns: number; rows: number }
type Ui = Elements['terminal']

// The transcript rows: a card floats over the rows above the end of one of them.
type Row = RenderOf<'UserMessage' | 'AssistantMessage' | 'ToolUse' | 'ToolResult' | 'ToolGroup' | 'CommandOutput' | 'TurnDuration' | 'InfoNotice'>
type OnScreen = NonNullable<Row['props']['onScreen']>

const draft = atom({ plugin: 'image-preview', key: 'draft' } as const, [] as number[])
const pictures = atom({ plugin: 'image-preview', key: 'pictures' } as const, {} as Record<string, Picture>)
const shown = atom({ plugin: 'image-preview', key: 'shown' } as const, null as Shown | null)
const hosting = atom({ plugin: 'image-preview', key: 'hosting' } as const, false)

const TOKEN = /\[Image #(\d+)\]/g
const NOT_STORED = 'not stored in this session'
const NO_FOLDER = "can't find this session's image folder"
// A cell is painted from eight dots across at most: cells need no more than 800 pixels.
const SOURCE_PIXELS = 800
const MAX_COLUMNS = 160
const MAX_ROWS = 48
// Below the transcript the screen holds the band, the prompt box and its hints; above the first
// row, the logo.
const BOTTOM_ROWS = 7
const HEADER_ROWS = 4
const MIN_CARD_ROWS = 6
// The card's frame and caption.
const CARD_COLUMNS = 2
const CARD_ROWS = 3
// Under a sent prompt the engine lists its images on rows that start with `  ⎿  `, and the
// prompt's first line follows `❯ ` on the row after an empty one.
const LISTED_AT = 5
const PROMPT_AT = 2
const WAIT_MS = 200
// Pasting an image puts its token in the box with no edit event: the box is polled.
const POLL_MS = 500
const WAIT_TRIES = 15
// The most a terminal is sent when it takes the picture as bytes.
const VIEW_PIXELS = 1024
const VIEW_BYTES = 2 * 1024 * 1024
// The Windows window: the picture's longer side in pixels, and how many seconds it stays if
// nothing closes it.
const WINDOW_SIZE = 800
const WINDOW_LIFE = 120
// What reads a picture, tried in this order: magick is ImageMagick 7 and convert ImageMagick 6
// (Ubuntu has the latter, NixOS both; on Windows `convert` is a disk tool), then what the system
// has of its own, sips on macOS and PowerShell with System.Drawing on Windows and under WSL.
type Tool = 'magick' | 'convert' | 'sips' | 'powershell'
type System = 'linux' | 'macos' | 'windows' | 'wsl'
const TOOLS: Record<System, Tool[]> = {
  linux: ['magick', 'convert'],
  macos: ['magick', 'convert', 'sips'],
  windows: ['magick', 'powershell'],
  wsl: ['magick', 'convert', 'powershell']
}

/** The ids of the `[Image #N]` tokens in a text, each once, in order. */
export const idsIn = (text: string) => [...new Set([...text.matchAll(TOKEN)].map(match => Number(match[1])))]

// Characters one cell wide: Latin, Cyrillic, Greek, punctuation, currency signs and the numero
// sign. With any other (wide or combining) a token's column cannot be counted.
const NARROW = /^[\n -\u02FF\u0370-\u052F\u2010-\u205E\u20A0-\u20C0\u2116]*$/

type Token = { id: number; row: number; column: number; length: number }

/**
 * The rows the engine wraps a prompt's line into at `width`: by words, the space at a break staying
 * at the end of its row. Each comes with where it starts in the line. Undefined when a word is
 * wider than a row: the engine cuts such a word, and where is not known.
 */
export function wrap (line: string, width: number) {
  const rows = [{ start: 0, text: '' }]
  let at = 0
  for (const [i, word] of line.split(' ').entries()) {
    if (word.length > width) return undefined
    let row = rows.at(-1)!
    if (i > 0) {
      if (row.text.length >= width) rows.push((row = { start: at, text: '' }))
      row.text += ' '
      at++
    }
    if (row.text.length > 0 && word.length > 0 && row.text.length + word.length > width) rows.push((row = { start: at, text: '' }))
    row.text += word
    at += word.length
  }
  return rows
}

function layout (text: string, width: number) {
  const tokens: Token[] = []
  let row = 0
  let offset = 0
  for (const line of text.split('\n')) {
    const rows = wrap(line, width)
    if (!rows) return undefined
    for (const match of line.matchAll(TOKEN)) {
      const at = rows.findLastIndex(each => each.start <= match.index)
      const { start, text: shown } = rows[at]!
      const column = match.index - start
      // A token split by a wrap has no place, and neither has one after a double space, which
      // the engine may collapse.
      if (column + match[0].length > shown.length || text.slice(0, offset + match.index).includes('  ')) continue
      tokens.push({ id: Number(match[1]), row: row + at, column, length: match[0].length })
    }
    row += rows.length
    offset += line.length + 1
  }
  return { rows: row, tokens }
}

/**
 * The `[Image #N]` tokens in a sent prompt: the row counted from the text's first row, and the
 * column from its left edge. The engine does not say how wide it wraps (the screen less `❯ `, or
 * one cell narrower), so the width taken is the one that gives `rowsDrawn` rows, as many as the
 * engine drew. No tokens when neither width fits, or when the count is unknown and the two widths
 * disagree.
 */
export function tokensOn (text: string, columns: number, rowsDrawn?: number): Token[] {
  if (!NARROW.test(text)) return []
  const fits = [columns - PROMPT_AT, columns - PROMPT_AT - 1]
    .map(width => layout(text, width))
    .filter(each => each !== undefined && (rowsDrawn === undefined || each.rows === rowsDrawn))
  const [first, ...rest] = fits
  const key = (tokens: Token[]) => JSON.stringify(tokens)
  return first && rest.every(each => key(each!.tokens) === key(first.tokens)) ? first.tokens : []
}

const sameIds = (a: readonly number[], b: readonly number[] = []) => a.length === b.length && a.every((id, i) => id === b[i])

const sizeOf = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

// Ghostty and kitty read the file themselves; a terminal named by
// CLAUDE_CODE_FORCE_TERMINAL_IMAGES is sent the bytes; the rest get cells.
let graphics: 'none' | 'file' | 'bytes' = 'none'
let sessionId: string | undefined
let folder: string | undefined
let madeFolder: string | undefined
let temp: string | undefined
let system: System = 'linux'
// Windows parts a path's folders with `\`; its own programs need a path written that way.
let sep = '/'
// Whether a card opens as a Windows window (on Windows and under WSL, when the terminal draws no
// pictures itself), and the window open now.
let windowed = false
let popup: { id: number; isOpen: boolean } | undefined
let tool: Tool | undefined
const thumbs = new Map<number, Pixels>()
const loading = new Set<number>()
const failed = new Set<number>()
const cells = new Map<string, string>()
const views = new Map<number, string>()
// Every transcript row drawn, by requestId: what it is, when it was first drawn and how many rows
// had been first drawn by its latest drawing, whether it came in the batch a session starts with,
// which of its rows are on screen, and the text of a composer prompt with `[Image #N]` in it. The
// move counter closes a card once its label may have left the pointer.
type Noted = { component: Row['component']; seen: number; drawnAt: number; isBatch: boolean; onScreen: OnScreen | null | undefined; text?: string }
const rows = new Map<string, Noted>()
let seenRows = 0
let cachedOrder: Map<string, number> | undefined
let cachedOrderSeen = -1
// The module loads when a session starts or on a reload, and the engine draws every row at once.
let isBatching = true
let seenAtLastLook = 0
let moves = 0
let movesShown = 0
let screenRows = 40
let draftIds: number[] = []
let hasShown = false
let poll: { cancel: () => void } | undefined

// What the debug log has been told already: a failure that stays would be written at every
// poll. A hundred distinct ones are plenty to go on.
const logged = new Set<string>()

/** Puts `text` in the debug log, the first time only. */
function logOnce ($: Engine, text: string) {
  if (logged.has(text) || logged.size >= 100) return
  logged.add(text)
  $.ui.log(text, { to: 'debug' })
}

/** After /clear the image ids start from 1 again: what the session before had read is forgotten. */
async function follow ($: Engine) {
  const id = await $.session.id()
  if (id === sessionId) return
  if (sessionId !== undefined) {
    rows.clear()
    cachedOrder = undefined
    cachedOrderSeen = -1
    moves++
  }
  sessionId = id
  folder = undefined
  madeFolder = undefined
  thumbs.clear()
  failed.clear()
  cells.clear()
  views.clear()
  await update($, pictures, () => ({}))
  await change($, () => null)
}

const join = (...parts: string[]) => parts.join(sep)

let detecting: Promise<void> | undefined

/**
 * Learns the system, once a session: whatever builds a path or runs a program waits for it, since
 * a resumed session draws its prompts before its start is over. It is told by `OS`, the distro's
 * name and `uname`: Claude Code 2.1.325 has no `$.session.info()`, and a module that calls it does
 * not load there at all.
 */
function detect ($: Engine) {
  return (detecting ??= (async () => {
    const [os, distro] = await Promise.all([$.env.get('OS'), $.env.get('WSL_DISTRO_NAME')])
    system = os === 'Windows_NT'
      ? 'windows'
      : distro !== undefined
        ? 'wsl'
        : (await $.process.run(['uname', '-s']).catch(() => undefined))?.stdout.trim() === 'Darwin' ? 'macos' : 'linux'
    sep = system === 'windows' ? '\\' : '/'
  })())
}

/**
 * Claude Code's temp folder: `<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>`, and on Windows
 * `<CLAUDE_CODE_TMPDIR or %TEMP%>\claude`.
 */
async function tempFolder ($: Engine) {
  const named = await $.env.get('CLAUDE_CODE_TMPDIR')
  if (system === 'windows') return `${(named || (await $.env.get('TEMP')) || (await $.env.get('TMP')) || '').replace(/[\\/]+$/, '')}\\claude`
  return `${(named || '/tmp').replace(/\/+$/, '')}/claude-${(await $.process.run(['id', '-u'])).stdout.trim()}`
}

/** The session's folder, where a pasted image is stored as `images/<N>.<ext>`. */
async function sessionFolder ($: Engine) {
  if (folder) return folder
  const id = await $.session.id()
  const root = (temp ??= await tempFolder($))
  const names = new Set([await $.session.root(), await $.session.cwd()].map(path => path.replace(/[^a-zA-Z0-9]/g, '-')))
  for (const name of names) {
    if (await $.fs.exists(join(root, name, id, 'images'))) return (folder = join(root, name, id))
  }
  // The engine shortens a long project path with a hash, and on Windows names the folder by a
  // hash alone: the session itself is looked for.
  for (const entry of await $.fs.list(root).catch(() => [])) {
    if (entry.kind === 'dir' && (await $.fs.exists(join(root, entry.name, id, 'images')))) {
      return (folder = join(root, entry.name, id))
    }
  }
  return undefined
}

async function fileOf ($: Engine, id: number) {
  const found = await sessionFolder($)
  if (!found) return undefined
  const name = (await $.fs.list(join(found, 'images')).catch(() => [])).find(entry => entry.name.startsWith(`${id}.`))?.name
  return name && /^\d+\.[a-z]+$/.test(name) ? join(found, 'images', name) : undefined
}

/** How `name` is run to write `file` as `format` to `name` in the folder `dir`. */
async function reading ($: Engine, name: Tool, file: string, dir: string, out: string, format: 'bmp' | 'png', side?: string) {
  if (name === 'sips') {
    // sips has no "only shrink": `-Z` also stretches a small picture, which a card does not mind.
    return { argv: ['sips', '-s', 'format', format, ...(side ? ['-Z', side.replace('>', '')] : []), file, '--out', join(dir, out)] }
  }
  if (name === 'powershell') return readerCommand(file, dir, out, format, side, await $.env.get('WSLENV'))
  const size = side && `${side.replace('>', '')}x${side}`
  return { argv: [name, file, ...(size ? ['-resize', size] : []), `${format === 'bmp' ? 'BMP3' : 'PNG'}:${join(dir, out)}`] }
}

type Run = { exitCode: number; stderr: string }
/** What a program that failed said: its first line on stderr less its own name, or its exit code. */
const saidBy = (name: string, result: Run) =>
  result.stderr.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.replace(new RegExp(`^${name}: `), '').slice(0, 200) || `exit code ${result.exitCode}`
/** A shell's code for a program it could not find. */
const NOT_FOUND = 127

/**
 * Writes `file` as `format` to `out` in the folder `dir`, with the first program that manages it,
 * its longer side `side` (`n` stretched or shrunk to it, `n>` only shrunk; without it, as it is).
 * True once one has; otherwise the first program that ran and failed, with what it said, or
 * undefined when none could be run.
 */
async function convert ($: Engine, file: string, dir: string, out: string, format: 'bmp' | 'png', side?: string) {
  let refused: { name: Tool; said: string } | undefined
  for (const name of tool ? [tool] : TOOLS[system]) {
    const { argv, env } = await reading($, name, file, dir, out, format, side) as { argv: string[]; env?: Record<string, string> }
    const result = await $.process.run(argv, env && { env }).catch(() => undefined)
    if (result?.exitCode === 0) {
      tool = name
      return true
    }
    if (result && result.exitCode !== NOT_FOUND) refused ??= { name, said: saidBy(name, result) }
  }
  return refused
}

async function makeFolder ($: Engine, path: string) {
  if (madeFolder === path) return
  const fail = (why: string) => { throw new Error(`can't create the cache folder: ${why}`) }
  // Windows has no `mkdir` program: writing a file makes its folders.
  if (system === 'windows') {
    await $.fs.write(join(path, '.keep'), '').catch(error => fail(error instanceof Error ? error.message : String(error)))
  } else {
    const result = await $.process.run(['mkdir', '-p', path])
    // mkdir ends its line with the reason, after the path: the card has no room for the path.
    if (result.exitCode !== 0) fail(saidBy('mkdir', result).split(': ').at(-1)!)
  }
  madeFolder = path
}

async function decode ($: Engine, file: string, dir: string, out: string): Promise<Pixels> {
  const done = await convert($, file, dir, out, 'bmp', String(SOURCE_PIXELS))
  if (done !== true) {
    // ImageMagick is named only where it is missing: a system reader runs only after it.
    throw new Error(!done ? 'needs ImageMagick to read it'
      : done.name === 'magick' || done.name === 'convert' ? `${done.name} can't read it: ${done.said}`
        : "the system can't read it; ImageMagick reads more formats")
  }
  const { base64 } = await $.fs.read(join(dir, out), { as: 'bytes' })
  return parseBmp(Uint8Array.fromBase64(base64))
}

async function pngOf ($: Engine, file: string, dir: string, out: string) {
  if (file.endsWith('.png')) return file
  return (await convert($, file, dir, out, 'png')) === true ? join(dir, out) : undefined
}

async function viewOf ($: Engine, file: string, dir: string, out: string) {
  if ((await convert($, file, dir, out, 'png', `${VIEW_PIXELS}>`)) !== true || (await $.fs.stat(join(dir, out))).size > VIEW_BYTES) return undefined
  return (await $.fs.read(join(dir, out), { as: 'bytes' })).base64
}

/** Reads the image `id` once; whatever is drawn waiting for it is drawn again. */
async function load ($: Engine, id: number) {
  if (thumbs.has(id) || loading.has(id) || failed.has(id)) return
  loading.add(id)
  let loadingIn: string | undefined
  let picture: Picture
  try {
    // A resumed session draws its prompts before its start has named it: the session is learned
    // here first, or a picture read meanwhile would be dropped as another session's.
    await detect($)
    await follow($)
    loadingIn = sessionId
    // The engine writes the file just after the paste has put the token in the box.
    let file = await fileOf($, id)
    for (let tries = 0; !file && tries < WAIT_TRIES; tries++) {
      await $.clock.sleep(WAIT_MS)
      file = await fileOf($, id)
    }
    if (!file) throw new Error((await sessionFolder($)) ? NOT_STORED : NO_FOLDER)

    const cache = join((await sessionFolder($))!, 'image-preview')
    await makeFolder($, cache)
    const pixels = await decode($, file, cache, `${id}.bmp`)
    let png: string | undefined
    if (graphics === 'file') png = await pngOf($, file, cache, `${id}.png`)
    if (graphics === 'bytes') {
      const view = await viewOf($, file, cache, `${id}.view.png`)
      if (view) {
        views.set(id, view)
        png = join(cache, `${id}.view.png`)
      }
    }
    const { size } = await $.fs.stat(file)
    if (sessionId === loadingIn) thumbs.set(id, pixels)
    const format = file.slice(file.lastIndexOf('.') + 1)
    picture = { file, format, bytes: size, width: pixels.width, height: pixels.height, ...(png && { png }) }
  } catch (error) {
    if (sessionId === loadingIn) failed.add(id)
    picture = { error: error instanceof Error ? error.message : String(error) }
  } finally {
    loading.delete(id)
  }
  if (sessionId !== loadingIn) return
  // The reading runs in the background: a module unloaded meanwhile has no state left to write.
  await update($, pictures, all => ({ ...all, [id]: picture })).catch(() => undefined)
}

/** Opens the image in the system's viewer: through Explorer on Windows and under WSL, `open` on macOS. */
async function openImage ($: Engine, id: number) {
  await detect($)
  const picture = (await read($, pictures))[id]
  const file = picture && !('error' in picture) ? picture.file : await fileOf($, id)
  if (!file) return
  if (system === 'wsl') {
    const path = (await $.process.run(['wslpath', '-w', file]).catch(() => undefined))?.stdout.trim()
    if (path) await $.process.run(['explorer.exe', path]).catch(() => undefined)
    return
  }
  const program = system === 'macos' ? 'open' : system === 'windows' ? 'explorer.exe' : 'xdg-open'
  await $.process.run([program, file]).catch(() => undefined)
}

/**
 * Keeps the window of the image `id` up until `closeWindow` ends it. The program prints a `.` ten
 * times a second: the loop wakes, sees the window closed, and leaving the loop ends the program.
 * If it ends without showing a window, there are no windows to be had here, and the terminal draws
 * the cards from then on.
 */
async function openWindow ($: Engine, id: number) {
  if (popup?.id === id && popup.isOpen) return
  closeWindow()
  const opening = { id, isOpen: true }
  popup = opening
  const picture = (await read($, pictures))[id]
  const file = picture && !('error' in picture) ? picture.file : await fileOf($, id)
  let isShown = false
  let said = ''
  if (file && opening.isOpen) {
    try {
      for await (const { text } of $.process.spawn(windowCommand(file, WINDOW_SIZE, WINDOW_LIFE, await $.env.get('WSLENV')))) {
        if (said.length < 2000) said += text
        if (/^shown\r?$/m.test(text)) isShown = true
        if (!opening.isOpen) break
      }
    } catch (error) {
      said += error instanceof Error ? error.message : String(error)
    }
  }
  if (popup === opening) popup = undefined
  if (isShown || !opening.isOpen) return
  // Claude Code leads the line with the plugin's name.
  $.ui.log(`no window (${said.replace(/\.\r?\n/g, '').trim().slice(0, 300) || 'the program could not start'}); the terminal draws the cards`, { to: 'debug' })
  windowed = false
  await change($, now => (now?.edge === 'window' ? placeFor(now.id, now.target) : now))
}

function closeWindow () {
  if (popup) popup.isOpen = false
  popup = undefined
}

/**
 * The picture in a frame with its caption, as large as the bounds allow. The card lies over the
 * transcript, which shows through every cell left unwritten: so each line is written at full
 * width, spaces included.
 */
function card ({ Box, Image, Raster, Text }: Ui, all: Record<string, Picture>, id: number, bounds: Bounds) {
  const label = `[Image #${id}]`
  const picture = all[id]
  const line = (text: string, width: number) => <Text dimColor wrap="truncate-end">{text.padEnd(width)}</Text>
  if (!picture || (!('error' in picture) && !thumbs.has(id))) return line(`${label} loading…`, bounds.columns)
  if ('error' in picture) return line(`${label} no preview: ${picture.error}`, bounds.columns)

  const { columns, rows } = fit(picture.width, picture.height, bounds.columns - CARD_COLUMNS, bounds.rows - CARD_ROWS)
  const view = views.get(id)
  const source = !picture.png ? undefined : graphics === 'file' ? { file: picture.png, format: 'png' as const } : view && { png: view }
  const key = `${id}:${columns}x${rows}`
  let painted = cells.get(key)
  if (!source && painted === undefined) {
    painted = toCells(thumbs.get(id)!, columns, rows)
    cells.set(key, painted)
  }
  const caption = `${label} ${picture.format.toUpperCase()} · ${sizeOf(picture.bytes)}`
  // A picture narrower than its caption is centered, with empty cells at its sides.
  const width = Math.max(columns, Math.min(caption.length, bounds.columns - CARD_COLUMNS))
  const side = (n: number) => n > 0 && <Text>{Array.from({ length: rows }, () => ' '.repeat(n)).join('\n')}</Text>
  const left = Math.floor((width - columns) / 2)
  return (
    <Box key={`card-${id}`} flexDirection="column" borderStyle="round" borderDimColor flexShrink={0} width={width + CARD_COLUMNS}>
      <Box flexDirection="row">
        {side(left)}
        {source
          ? <Image key={`image-${id}`} source={source} columns={columns} rows={rows} alt={label} />
          : <Raster key={`image-${id}`} columns={columns} rows={rows} cells={painted!} />}
        {side(width - columns - left)}
      </Box>
      {line(caption, width)}
    </Box>
  )
}

const sameShown = (a: Shown | null, b: Shown | null) =>
  a === b || (a !== null && b !== null && a.id === b.id && a.target === b.target && a.host === b.host && a.rows === b.rows && a.edge === b.edge)

let changing = Promise.resolve()

/**
 * Opens, moves or closes (null) the card, one change at a time: the pointer leaving one token and
 * entering the next are reported in either order. Only the row the card left and the row it came
 * to are drawn again.
 */
function change ($: Engine, next: (now: Shown | null) => Shown | null) {
  const run = changing.then(async () => {
    const last = await read($, shown)
    const to = next(last)
    movesShown = moves
    hasShown = to !== null
    if (sameShown(last, to)) return
    await update($, shown, () => to)
    if (last?.host && last.host !== to?.host) await update($, memberOf(hosting, { requestId: last.host }), () => false)
    if (to?.host && to.host !== last?.host) await update($, memberOf(hosting, { requestId: to.host }), () => true)
    if (to?.edge === 'window') void openWindow($, to.id)
    else closeWindow()
  })
  changing = run.catch(() => undefined)
  return run
}

const isFromPrompt = (now: Shown) => /\/(sent|token):/.test(now.target)

const closeChipCard = (now: Shown | null) => (now && !isFromPrompt(now) ? null : now)

/** A target is `<site>/<chip key>`; for the tokens of a sent prompt the site is the prompt itself. */
const placeFor = (id: number, target: string) => placeOf(id, target, /\/chip:/.test(target) ? undefined : target.slice(0, target.indexOf('/')))

/**
 * Notes a transcript row before the first await, so in the transcript's order. True when a prompt
 * with labels went out of the viewport or came back: the row under its list draws its chips
 * meanwhile (`chipsUnder`), and the engine would not draw that row again if it did not move.
 */
function note (e: Row) {
  if (e.viewport && e.viewport.rows !== screenRows) {
    screenRows = e.viewport.rows
    moves++
  }
  const onScreen = e.props.onScreen
  const row = rows.get(e.requestId)
  if (!row) {
    const seen = seenRows++
    const text = e.component === 'UserMessage' && e.props.origin.kind === 'composer' && idsIn(e.props.text).length > 0 ? e.props.text : undefined
    rows.set(e.requestId, { component: e.component, seen, drawnAt: seenRows, isBatch: isBatching, onScreen, ...(text !== undefined && { text }) })
    moves++
    return false
  }
  row.drawnAt = seenRows
  const isHidden = row.onScreen === null
  if (row.onScreen?.first !== onScreen?.first || row.onScreen?.last !== onScreen?.last || row.onScreen?.of !== onScreen?.of || isHidden !== (onScreen === null)) {
    row.onScreen = onScreen
    moves++
  }
  return row.text !== undefined && isHidden !== (onScreen === null)
}

/**
 * A row the engine drew under a temporary id and then replaced: a prompt before it is stored
 * (`placeholder`, replaced by the very next row) and a tool group until its turn ends
 * (`collapsed-toolu_…`). The engine never draws a replaced row again, so its last place on screen
 * would inflate the count of lines for good.
 */
function isReplaced (requestId: string, row: Noted) {
  if (requestId === 'placeholder') return seenRows > row.drawnAt
  if (!requestId.startsWith('collapsed-toolu_')) return false
  for (const other of rows.values()) if (other.component === 'TurnDuration' && other.seen >= row.drawnAt) return true
  return false
}

/**
 * The rows in the transcript's order. A row drawn as the session goes is where it was drawn. The
 * batch a session starts with, or a reload, comes in two passes, the prompts apart from the rest:
 * each prompt is put at the start of its turn, after the duration row of the turn before, the last
 * prompt with the last turn.
 */
function transcriptOrder () {
  if (cachedOrder && cachedOrderSeen === seenRows) return cachedOrder
  const bySeen = (a: [string, Noted], b: [string, Noted]) => a[1].seen - b[1].seen
  const batch = [...rows].filter(([, row]) => row.isBatch).sort(bySeen)
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
  for (const [id, row] of rows) if (!row.isBatch) order.set(id, ordered.length + row.seen)
  cachedOrder = order
  cachedOrderSeen = seenRows
  return order
}

/**
 * The composer prompt with labels right above transcript row `requestId`, while the engine draws
 * that prompt outside the viewport (`onScreen` null). Its rows may be gone under the top row while
 * the list of its images, drawn by the engine between it and this row, still shows: the engine
 * then hit-tests nothing the prompt drew, its chips over the list included.
 */
function hiddenPromptAbove (requestId: string) {
  const order = transcriptOrder()
  const mine = order.get(requestId)
  if (mine === undefined) return undefined
  let above: string | undefined
  let aboveAt = -Infinity
  for (const [id, at] of order) {
    const row = rows.get(id)
    if (at < mine && at > aboveAt && row && !isReplaced(id, row)) {
      above = id
      aboveAt = at
    }
  }
  const row = above === undefined ? undefined : rows.get(above)
  return row?.text !== undefined && row.onScreen === null ? above : undefined
}

/**
 * Chips over the list of a hidden prompt's images (`hiddenPromptAbove`), drawn from the row under
 * the list, which ends just above that row's own first row. Keyed `list:N`: `ui.message` reads one
 * as the prompt's `sent:N`.
 */
async function chipsUnder ($: Engine, e: Row): Promise<RenderElement[]> {
  const prompt = hiddenPromptAbove(e.requestId)
  const text = prompt === undefined ? undefined : rows.get(prompt)?.text
  if (text === undefined) return []
  const all = await read($, pictures)
  // The engine lists each stored image, read or not, in the order pasted.
  const listed = idsIn(text).filter(id => { const picture = all[id]; return picture && !('error' in picture && picture.error === NOT_STORED) })
  listed.sort((a, b) => a - b)
  const { Box, Client } = $.ui.resolve(e)
  return listed.flatMap((id, i) => 'error' in all[id]!
    ? []
    : [
        <Box key={`under-${id}`} position="absolute" top={i - listed.length} left={LISTED_AT}>
          <Client key={`list:${id}`} module="./chip.tsx" width={`[Image #${id}]`.length} height={1} />
        </Box>
      ])
}

/**
 * Where the card goes. From a band chip: in the band, above the prompt box, where it covers no text.
 * From a sent prompt (`prompt`) it floats, never over the label that opened it and only over rows
 * drawn before the one it stands on (one drawn later paints over it): over the rows above the
 * prompt or under its list, whichever has more room, and under the list when the prompt itself is
 * off screen; nowhere when it fits neither. Only known rows count, so the count is never too high.
 */
function placeOf (id: number, target: string, prompt?: string): Shown | null {
  if (windowed) return { id, target, host: null, rows: 0, edge: 'window' }
  if (prompt === undefined) return { id, target, host: null, rows: 0, edge: 'last' }
  const order = transcriptOrder()
  const showing = [...rows]
    .filter(([requestId, row]) => !!row.onScreen && !isReplaced(requestId, row))
    .map(([id, row]) => [id, { order: order.get(id)!, onScreen: row.onScreen! }] as const)
  // A row first drawn late (scrolled into view) stands where the screen's edge cuts it.
  const placeOn = ({ order, onScreen }: { order: number; onScreen: OnScreen }) =>
    onScreen.first > 0 ? -Infinity : onScreen.last < onScreen.of - 1 ? Infinity : order
  showing.sort((a, b) => placeOn(a[1]) - placeOn(b[1]) || a[1].order - b[1].order)
  const room = screenRows - BOTTOM_ROWS
  const lowest = showing.at(-1)
  const top = showing[0]?.[1]
  // A row off screen, or a first row that is cut, means the transcript fills the screen.
  const isFull = top !== undefined && (top.onScreen.first > 0 || [...rows.values()].some(row => row.onScreen === null))
  const count = (list: typeof showing) => list.reduce((sum, [, row]) => sum + row.onScreen.last - row.onScreen.first + 1, 0)

  const at = showing.findIndex(([requestId]) => requestId === prompt)
  if (at === -1) {
    // A hidden prompt whose list still shows (`hiddenPromptAbove`) has its list at the top: the
    // card goes under the list, over the rows that follow the prompt.
    const from = order.get(prompt)
    if (from === undefined || rows.get(prompt)?.onScreen !== null) return null
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

/**
 * Keeps the open card in step with the transcript. A sent prompt's token moves with the prompt and
 * says nothing when it slides from under a pointer that stays still: so its card closes on any
 * move. The band's chips stay where they are, and so does their card.
 */
async function settle ($: Engine) {
  if (seenRows === seenAtLastLook) isBatching = false
  seenAtLastLook = seenRows
  if (!hasShown || moves === movesShown) return
  await change($, now => !now || !isFromPrompt(now) ? now : moves === movesShown ? now : null)
}

/**
 * A transcript row with what floats over it out of the flow, so nothing moves: the card when it
 * stands on this row, `overlays`, and the chips of a hidden prompt's list right above it.
 */
async function float ($: Engine, e: Row, drawn: RenderElement, overlays: RenderElement[] = []) {
  overlays = [...overlays, ...(await chipsUnder($, e))]
  const now = (await read($, memberOf(hosting, e))) ? await read($, shown) : null
  const onScreen = e.props.onScreen
  const isHost = now !== null && now.host === e.requestId && !!onScreen
  if (!isHost && overlays.length === 0) return drawn
  const ui = $.ui.resolve(e)
  const { Box } = ui
  let floating: RenderElement | undefined
  if (isHost) {
    const bounds = { columns: Math.max(8, Math.min(MAX_COLUMNS, (e.viewport?.columns ?? 80) - 4)), rows: Math.min(MAX_ROWS, now.rows) }
    const bottom = now.edge === 'last' ? onScreen.of - 1 - onScreen.last : onScreen.of - 1
    floating = (
      <Box key={`float-${now.id}`} position="absolute" bottom={bottom} left={0}>
        {card(ui, await read($, pictures), now.id, bounds)}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {drawn}
      {overlays}
      {floating}
    </Box>
  )
}

async function track ($: Engine, text: string) {
  await follow($)
  const ids = idsIn(text)
  if (!sameIds(ids, draftIds)) {
    draftIds = ids
    await update($, draft, () => ids)
    if (hasShown) await change($, closeChipCard)
  }
  for (const id of ids) void load($, id)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    poll?.cancel()
    poll = undefined
    const result = await next(e)
    const [program, term, kittyWindow, forceImages, tmux, sshConnection, sshTty] = await Promise.all([
      $.env.get('TERM_PROGRAM'),
      $.env.get('TERM'),
      $.env.get('KITTY_WINDOW_ID'),
      $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES'),
      $.env.get('TMUX'),
      $.env.get('SSH_CONNECTION'),
      $.env.get('SSH_TTY')
    ])
    // Inside tmux the terminal's own variables are still there, but tmux passes no pictures through
    // and the engine draws none: the card would hold the picture's name alone.
    const isNative = tmux === undefined && (program === 'ghostty' || term === 'xterm-ghostty' || term === 'xterm-kitty' || kittyWindow !== undefined)
    graphics = isNative ? 'file' : /^(1|true|yes|on)$/i.test(forceImages ?? '') ? 'bytes' : 'none'
    detecting = undefined
    await detect($)
    tool = undefined
    temp = undefined
    // Over SSH the window would open on another machine's desktop.
    windowed = (system === 'windows' || system === 'wsl') && graphics === 'none' && e.isInteractive && sshConnection === undefined && sshTty === undefined
    // A reload starts with an empty cache: what is in the box already is read again.
    await follow($)
    const [initialDraft, initialShown, box] = await Promise.all([read($, draft), read($, shown), $.prompt.read()])
    draftIds = initialDraft
    hasShown = initialShown !== null
    await track($, box.text)
    if (e.isInteractive) {
      // A poll that fails as the module unloads is left to the next one.
      poll = $.clock.every(POLL_MS, () => {
        void $.prompt.read().then(box => track($, box.text)).then(() => settle($))
          .catch(error => logOnce($, `polling the prompt box failed: ${error instanceof Error ? error.message : String(error)}`))
      })
    }
    return result
  })

  on('session.end', ($, e, next) => {
    poll?.cancel()
    poll = undefined
    closeWindow()
    return next(e)
  })

  // Typing closes the card a chip in the band opened: the box may grow and move the chip from
  // under the pointer.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    if (hasShown) await change($, closeChipCard)
    await track($, box.text)
    return box
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind !== 'composer') return result
    draftIds = []
    await update($, draft, () => [])
    await change($, () => null)
    for (const id of idsIn(e.text)) void load($, id)
    return result
  }).catch(($, e, next) => next(e))

  on('ui.message', async ($, e, next) => {
    const result = await next(e)
    const chip = /^(chip|sent|token|list):(\d+)$/.exec(e.element)
    if (!chip) return result
    // A chip the row under a hidden prompt drew over the prompt's list stands for the prompt's own.
    const site = chip[1] === 'list' ? hiddenPromptAbove(e.requestId) : e.requestId
    if (site === undefined) return result
    const target = chip[1] === 'list' ? `${site}/sent:${chip[2]}` : `${site}/${e.element}`
    const data = e.data as { isOver?: unknown; isClicked?: unknown } | null
    // A card left open would lie over the viewer.
    if (data?.isClicked === true) {
      void openImage($, Number(chip[2]))
      await change($, () => null)
      return result
    }
    const isOver = data?.isOver === true
    await change($, now => (!isOver ? (now?.target === target ? null : now) : now?.target === target ? now : placeFor(Number(chip[2]), target)))
    return result
  })

  // One hook notes every row, so that rows drawn together (after a reload) come in the
  // transcript's order. Under a sent prompt the engine lists the images, a `⎿ [Image #N]` to a
  // row: each gets an unpainted chip over it, so the engine's row shows as it was.
  on('ui.render', { component: ['UserMessage', 'AssistantMessage', 'ToolUse', 'ToolResult', 'ToolGroup', 'CommandOutput', 'TurnDuration', 'InfoNotice'] }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.viewport?.isFullscreen === false) return next(e)
    if (note(e)) $.ui.invalidate('ui.render')
    if (e.component !== 'UserMessage') return float($, e, await next(e))
    const ids = e.props.origin.kind === 'composer' ? idsIn(e.props.text) : []
    if (ids.length === 0) return float($, e, await next(e))
    const all = await read($, pictures)
    // Not only the ids the state lacks: after a reload it may hold what the module before wrote,
    // and `load` skips whatever this one has read.
    for (const id of ids) void load($, id)
    const drawn = await next(e)
    // The engine lists every stored image, read or not, in the order pasted.
    const listed = ids.filter(id => { const picture = all[id]; return picture && !('error' in picture && picture.error === NOT_STORED) })
    listed.sort((a, b) => a - b)
    const { Box, Client } = $.ui.resolve(e)
    const overlays: RenderElement[] = []
    listed.forEach((id, i) => {
      if ('error' in all[id]!) return
      overlays.push(
        <Box key={`listed-${id}`} position="absolute" bottom={-1 - i} left={LISTED_AT}>
          <Client key={`sent:${id}`} module="./chip.tsx" width={`[Image #${id}]`.length} height={1} />
        </Box>
      )
    })
    // The engine keeps the click on the list's rows to itself: a click on the token in the
    // prompt's text is what opens the image. An image the engine did not attach to the prompt (a
    // large one goes to the model as a file) is not listed either: the token in the text is then
    // the only thing to hover.
    const shown = e.props.onScreen
    const placed = new Set<number>()
    for (const { id, row, column, length } of tokensOn(e.props.text, e.viewport?.columns ?? 80, shown ? shown.of - 1 : undefined)) {
      const picture = all[id]
      if (placed.has(id) || !picture || 'error' in picture) continue
      placed.add(id)
      overlays.push(
        <Box key={`token-${id}`} position="absolute" top={1 + row} left={PROMPT_AT + column}>
          <Client key={`token:${id}`} module="./chip.tsx" width={length} height={1} />
        </Box>
      )
    }
    return float($, e, drawn, overlays)
  })

  // The draft's images as chips above the prompt box, and the card one of them opened.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Off fullscreen the terminal reports no pointer: there is nothing to hover with.
    if (e.surface !== 'terminal' || e.props.hasSurvey || e.viewport?.isFullscreen === false) return next(e)
    const [ids, now] = await Promise.all([read($, draft), read($, shown)])
    const inBand = now && now.host === null && now.edge !== 'window' ? now.id : undefined
    if (ids.length === 0 && inBand === undefined) return next(e)
    if (e.viewport) screenRows = e.viewport.rows

    const ui = $.ui.resolve(e)
    const { Box, Client, Text } = ui
    const below: RenderElement = await next(e)
    const bounds = {
      columns: Math.max(8, Math.min(MAX_COLUMNS, e.props.bodyColumns)),
      rows: Math.max(4, Math.min(MAX_ROWS, e.props.maxRows - 1))
    }
    return (
      <Box flexDirection="column">
        {below}
        {inBand !== undefined && card(ui, await read($, pictures), inBand, bounds)}
        {ids.length > 0 && (
          <Box flexDirection="row" columnGap={1}>
            {ids.map(id => <Client key={`chip:${id}`} module="./chip.tsx" props={{ label: `[Image #${id}]` }} />)}
            <Text dimColor>hover to preview · click to open</Text>
          </Box>
        )}
      </Box>
    )
  })
}
