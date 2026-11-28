// A pasted image, [Image #N], previewed on hover: above the prompt box while the prompt is being
// written, and on the prompts already sent. Ghostty and kitty draw the picture itself, on Windows
// and under WSL a Windows window by the pointer shows it, and other terminals paint colored cells.
// Based on image-preview from better-claude (MIT, ../LICENSE), without its macOS and Tk windows.
import { atom, memberOf, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import { fit, parseBmp, toCells } from './pixels'
import { printable } from './printable'
import { sizeOf } from './size'
import { forgetSystem, show, systemOf } from './system'
import type { System } from './system'
import { Ledger, TRANSCRIPT } from './ledger'
import { forgetReaders, saidBy, write } from './readers'
import type { Placed, Queued, Row } from './ledger'
import { idsIn, PROMPT_AT, tokensOn } from './tokens'
import { windowCommand } from './window'
import type { Pixels } from './pixels'
import type { Picture, Shown } from '../types'

type Engine = EngineInterface
type Bounds = { columns: number; rows: number }
type Ui = Elements['terminal']

const draft = atom({ plugin: 'image-preview', key: 'draft' } as const, [] as number[])
const pictures = atom({ plugin: 'image-preview', key: 'pictures' } as const, {} as Record<string, Picture>)
const shown = atom({ plugin: 'image-preview', key: 'shown' } as const, null as Shown | null)
const hosting = atom({ plugin: 'image-preview', key: 'hosting' } as const, false)

const NOT_STORED = 'not stored in this session'
const NO_FOLDER = "can't find this session's image folder"
// A cell is painted from eight dots across at most: cells need no more than 800 pixels.
const SOURCE_PIXELS = 800
const MAX_COLUMNS = 160
const MAX_ROWS = 48
// The card's frame and caption.
const CARD_COLUMNS = 2
const CARD_ROWS = 3
// Under a sent prompt the engine lists its images on rows that start with `  ⎿  `; the prompt's
// first line is on the row after an empty one.
const LISTED_AT = 5
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
// After a window fails, how long the terminal draws the cards before a window is tried again.
const WINDOW_RETRY_MS = 5 * 60 * 1000
// How many pictures' pixels are kept: each takes megabytes, and an older one is read again.
const KEPT = 8

const sameIds = (a: readonly number[], b: readonly number[] = []) => a.length === b.length && a.every((id, i) => id === b[i])

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
// Whether this session may open windows at all, and which failure turned them off last.
let canWindow = false
let windowsOff = 0
let popup: { id: number; isOpen: boolean } | undefined
const thumbs = new Map<number, Pixels>()
const loading = new Set<number>()
const failed = new Set<number>()
const cells = new Map<string, string>()
const views = new Map<number, string>()
const ledger = new Ledger()
let movesShown = 0
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

/**
 * A new session, /clear included, keeps its images in a folder of its own while the image ids go
 * on counting: what the session before had read is forgotten.
 */
async function followSession ($: Engine) {
  const id = await $.session.id()
  if (id === sessionId) return
  if (sessionId !== undefined) ledger.clear()
  sessionId = id
  transcript = undefined
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

let lastPlace = ''

/**
 * Puts where a card floats, and the rows it was measured on, in the debug log once each time it
 * changes: a card off its place shows there by its numbers (`--debug-file`).
 */
function logPlace ($: Engine, text: string) {
  if (text === lastPlace) return
  lastPlace = text
  $.ui.log(text, { to: 'debug' })
}

let reading: Promise<void> | undefined
let canRead = true
type RangedRead = { messages: (args: { last: number } | { after: string }) => Promise<readonly Placed[] | { deny: string }> }

// How much of the session's file one read takes; a read may return at most 4 MiB.
const TRANSCRIPT_CHUNK = 1024 * 1024
// How many of the messages stored before a queued prompt are kept: a message the engine's read
// leaves out (some tool results) is skipped for the one before it.
const KEPT_BEFORE = 16
type FileRange = { read: (path: string, range: { offset: number; length: number }) => Promise<string> }

/** The session's file as read so far: up to `offset`, `rest` an unfinished line, the newest messages first. */
let transcript: { path: string; offset: number; rest: string; recent: string[] } | null | undefined

/**
 * The session's file, `<config>/projects/<project>/<id>.jsonl`; null where it is not found. The
 * engine shortens a long project path with a hash: the file is then looked for.
 */
async function transcriptPath ($: Engine) {
  const id = await $.session.id()
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  const projects = join((await $.env.get('CLAUDE_CONFIG_DIR')) || join(home, '.claude'), 'projects')
  const names = new Set([await $.session.root(), await $.session.cwd()].map(path => path.replace(/[^a-zA-Z0-9]/g, '-')))
  for (const name of names) {
    if (await $.fs.exists(join(projects, name, `${id}.jsonl`))) return join(projects, name, `${id}.jsonl`)
  }
  for (const entry of await $.fs.list(projects).catch(() => [])) {
    if (entry.kind === 'dir' && (await $.fs.exists(join(projects, entry.name, `${id}.jsonl`)))) return join(projects, entry.name, `${id}.jsonl`)
  }
  return null
}

/**
 * Tells the ledger where the prompts queued while a turn ran stand: the engine's read of the
 * messages leaves them out, the session's file has them as attachments. Reads what the file grew
 * by since the last time.
 */
async function readQueued ($: Engine) {
  if (transcript === undefined) {
    const path = await transcriptPath($)
    transcript = path === null ? null : { path, offset: 0, rest: '', recent: [] }
  }
  if (transcript === null) return
  const file = transcript
  const { size } = await $.fs.stat(file.path)
  if (size < file.offset) Object.assign(file, { offset: 0, rest: '', recent: [] })
  const queued: Queued[] = []
  while (file.offset < size) {
    const length = Math.min(TRANSCRIPT_CHUNK, size - file.offset)
    const text = await ($.fs as unknown as FileRange).read(file.path, { offset: file.offset, length })
    file.offset += length
    const lines = (file.rest + text).split('\n')
    file.rest = lines.pop()!
    for (const line of lines) {
      let entry: { type?: unknown; uuid?: unknown; isSidechain?: unknown; attachment?: { type?: unknown } }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.isSidechain === true || typeof entry.uuid !== 'string') continue
      if (entry.type === 'user' || entry.type === 'assistant') {
        file.recent.unshift(entry.uuid)
        file.recent.length = Math.min(file.recent.length, KEPT_BEFORE)
      } else if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') {
        queued.push({ uuid: entry.uuid, after: [...file.recent] })
      }
    }
  }
  ledger.learnQueued(queued)
}

/**
 * Tells the ledger where the messages stand, while a row was drawn that none read so far places,
 * and the queued prompts, while a prompt row was drawn that nothing learnt places. Claude Code
 * 2.1.325 refuses a ranged read: rows then stand in the order drawn.
 */
function readMessages ($: Engine) {
  if (reading || !canRead || !ledger.isBehind) return
  reading = (async () => {
    while (ledger.isBehind) {
      ledger.isBehind = false
      const after = ledger.lastRead
      const got = await ($.session as unknown as RangedRead).messages(after === undefined ? { last: 4096 } : { after })
      if (!('deny' in got)) ledger.learn(got)
      else if (after === undefined) return
      else {
        // The transcript was cut (compacted): read it again.
        ledger.forget()
        ledger.isBehind = true
      }
    }
    if (ledger.hasLoosePrompt() && transcript !== null) {
      await readQueued($).catch((error: unknown) => {
        transcript = null
        logOnce($, `reading the session's file for queued prompts failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  })().catch((error: unknown) => {
    canRead = false
    logOnce($, `reading the transcript's order failed: ${error instanceof Error ? error.message : String(error)}`)
  }).finally(() => { reading = undefined })
}

let detecting: Promise<void> | undefined

/**
 * Learns the system, once a session: whatever builds a path or runs a program waits for it, since
 * a resumed session draws its prompts before its start is over.
 */
function detect ($: Engine) {
  return (detecting ??= systemOf($).then(found => {
    system = found
    sep = system === 'windows' ? '\\' : '/'
  }))
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
  const done = await write($, system, file, dir, out, 'bmp', { pixels: SOURCE_PIXELS, isShrinkOnly: false })
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
  return (await write($, system, file, dir, out, 'png')) === true ? join(dir, out) : undefined
}

async function viewOf ($: Engine, file: string, dir: string, out: string) {
  if ((await write($, system, file, dir, out, 'png', { pixels: VIEW_PIXELS, isShrinkOnly: true })) !== true || (await $.fs.stat(join(dir, out))).size > VIEW_BYTES) return undefined
  return (await $.fs.read(join(dir, out), { as: 'bytes' })).base64
}

/** Keeps the pixels of `id` as the latest, letting go of the oldest past `KEPT` and what was drawn from them. */
function keep (id: number, pixels: Pixels) {
  thumbs.delete(id)
  thumbs.set(id, pixels)
  for (const old of [...thumbs.keys()].slice(0, Math.max(0, thumbs.size - KEPT))) {
    thumbs.delete(old)
    views.delete(old)
    for (const key of cells.keys()) if (key.startsWith(`${old}:`)) cells.delete(key)
  }
}

/** Reads the pixels of a picture that was read once and let go, before its card is drawn. */
async function reread ($: Engine, id: number) {
  const picture = (await read($, pictures))[id]
  if (picture && !('error' in picture) && !thumbs.has(id)) void load($, id)
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
    await followSession($)
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
    if (sessionId === loadingIn) keep(id, pixels)
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

/** Opens the image in the system's viewer. */
async function openImage ($: Engine, id: number) {
  await detect($)
  const picture = (await read($, pictures))[id]
  const file = picture && !('error' in picture) ? picture.file : await fileOf($, id)
  if (file) await show($, file, false)
}

/**
 * Keeps the window of the image `id` up until `closeWindow` ends it. The program prints a `.` ten
 * times a second: the loop wakes, sees the window closed, and leaving the loop ends the program.
 * If it ends without showing a window, the terminal draws the cards for `WINDOW_RETRY_MS`, and then
 * a window is tried again.
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
  $.ui.log(`no window (${said.replace(/\.\r?\n/g, '').trim().slice(0, 300) || 'the program could not start'}); the terminal draws the cards for five minutes`, { to: 'debug' })
  windowed = false
  const off = ++windowsOff
  // A module unloaded meanwhile ends the wait: nothing is left to turn back on.
  void $.clock.sleep(WINDOW_RETRY_MS).then(() => { if (off === windowsOff) windowed = canWindow }, () => undefined)
  await change($, now => (now?.edge === 'window' ? placeFor(now.id, now.target) : now))
}

function closeWindow () {
  if (popup) popup.isOpen = false
  popup = undefined
}

const pictureIn = (picture: { width: number; height: number }, bounds: Bounds) =>
  fit(picture.width, picture.height, bounds.columns - CARD_COLUMNS, bounds.rows - CARD_ROWS)

/**
 * The picture in a frame with its caption, as large as the bounds allow. The card lies over the
 * transcript, which shows through every cell left unwritten: so each line is written at full
 * width, spaces included.
 */
function card ({ Box, Image, Raster, Text }: Ui, all: Record<string, Picture>, id: number, bounds: Bounds) {
  const label = `[Image #${id}]`
  const picture = all[id]
  const line = (text: string, width: number) => <Text dimColor wrap="truncate-end">{printable(text).padEnd(width)}</Text>
  if (!picture || (!('error' in picture) && !thumbs.has(id))) return line(`${label} loading…`, bounds.columns)
  if ('error' in picture) return line(`${label} no preview: ${picture.error}`, bounds.columns)

  const { columns, rows } = pictureIn(picture, bounds)
  const view = views.get(id)
  const source = !picture.png ? undefined : graphics === 'file' ? { file: picture.png, format: 'png' as const } : view && { png: view }
  const key = `${id}:${columns}x${rows}`
  let painted = cells.get(key)
  if (!source && painted === undefined) {
    painted = toCells(thumbs.get(id)!, columns, rows)
    for (const other of cells.keys()) if (other.startsWith(`${id}:`)) cells.delete(other)
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
    movesShown = ledger.moves
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
const placeFor = (id: number, target: string): Shown | null => windowed
  ? { id, target, host: null, rows: 0, edge: 'window' }
  : ledger.placeOf(id, target, /\/chip:/.test(target) ? undefined : target.slice(0, target.indexOf('/')))

/**
 * Chips over the list of a hidden prompt's images (`hiddenPromptAbove`), drawn from the row under
 * the list, which ends just above that row's own first row. Keyed `list:N`: `ui.message` reads one
 * as the prompt's `sent:N`.
 */
async function chipsUnder ($: Engine, e: Row): Promise<RenderElement[]> {
  const prompt = ledger.hiddenPromptAbove(e.requestId)
  const text = prompt === undefined ? undefined : ledger.rows.get(prompt)?.text
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
 * Keeps the open card in step with the transcript. A sent prompt's token moves with the prompt and
 * says nothing when it slides from under a pointer that stays still: so its card closes on any
 * move. The band's chips stay where they are, and so does their card.
 */
async function settle ($: Engine) {
  if (!hasShown || ledger.moves === movesShown) return
  await change($, now => !now || !isFromPrompt(now) ? now : ledger.moves === movesShown ? now : null)
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
    await reread($, now.id)
    const bounds = { columns: Math.max(8, Math.min(MAX_COLUMNS, (e.viewport?.columns ?? 80) - 4)), rows: Math.min(MAX_ROWS, now.rows) }
    const bottom = now.edge === 'last' ? onScreen.of - 1 - onScreen.last : onScreen.of - 1
    const picture = (await read($, pictures))[now.id]
    const size = picture && !('error' in picture) ? pictureIn(picture, bounds) : undefined
    logPlace($, `card ${now.id} on ${e.requestId.slice(0, 13)} ${e.component} ${onScreen.first}-${onScreen.last}/${onScreen.of} at its ${now.edge} row, bottom ${bottom}: room ${now.rows} rows, card ${size ? `${size.rows + CARD_ROWS} rows (picture ${size.columns}x${size.rows})` : '1 row'}; ${ledger.describe()}`)
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
  await followSession($)
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
    forgetSystem()
    detecting = undefined
    await detect($)
    forgetReaders()
    temp = undefined
    // Over SSH the window would open on another machine's desktop.
    canWindow = (system === 'windows' || system === 'wsl') && graphics === 'none' && e.isInteractive && sshConnection === undefined && sshTty === undefined
    windowed = canWindow
    windowsOff++
    // A reload starts with an empty cache: what is in the box already is read again.
    await followSession($)
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
    const site = chip[1] === 'list' ? ledger.hiddenPromptAbove(e.requestId) : e.requestId
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

  // One hook notes every row, so that rows drawn together (after a reload) come in the order
  // drawn. Under a sent prompt the engine lists the images, a `⎿ [Image #N]` to a
  // row: each gets an unpainted chip over it, so the engine's row shows as it was.
  on('ui.render', { component: [...TRANSCRIPT] }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.viewport?.isFullscreen !== true) return next(e)
    if (ledger.note(e)) $.ui.invalidate('ui.render')
    readMessages($)
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
    const onScreen = e.props.onScreen
    const placed = new Set<number>()
    for (const { id, row, column, length } of tokensOn(e.props.text, e.viewport?.columns ?? 80, onScreen ? onScreen.of - 1 : undefined)) {
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
    if (e.surface !== 'terminal' || e.props.hasSurvey || e.viewport?.isFullscreen !== true) return next(e)
    const [ids, now] = await Promise.all([read($, draft), read($, shown)])
    const inBand = now && now.host === null && now.edge !== 'window' ? now.id : undefined
    if (ids.length === 0 && inBand === undefined) return next(e)
    if (e.viewport) ledger.screenRows = e.viewport.rows

    const ui = $.ui.resolve(e)
    const { Box, Client, Text } = ui
    const below: RenderElement = await next(e)
    if (inBand !== undefined) await reread($, inBand)
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
