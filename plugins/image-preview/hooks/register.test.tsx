// Mod tests, run against the engine itself: `claude plugin test .`
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { bmp } from './bmp.testing'
import { READER, WINDOWS } from './window'

const FOLDER = '/tmp/claude-501/-project-app/s-1'
// Windows keeps the session's folder under %TEMP%\claude, the project named by a hash.
const WIN_TEMP = 'C:\\Users\\ana\\AppData\\Local\\Temp'
const WIN_PROJECT = 'ab12cd34ef56ab78'
const WIN_FOLDER = `${WIN_TEMP}\\claude\\${WIN_PROJECT}\\s-1`
const POWERSHELL = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']
const SSH = { SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22' }
// Under WSL the session is in Linux, while the desktop, the pointer and the viewer are Windows'.
const WSL = { WSL_DISTRO_NAME: 'Ubuntu', WSLENV: 'WT_SESSION' }
const RED = 0xff0000
const BLUE = 0x0000ff
// What ImageMagick writes for the terminal to draw: a PNG, one red pixel.
// The limits ImageMagick reads a pasted picture under.
const LIMITS = ['-limit', 'memory', '256MiB', '-limit', 'map', '512MiB', '-limit', 'area', '128MP', '-limit', 'disk', '1GiB', '-limit', 'time', '30']
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

/**
 * The path as the mocked session wrote it. A Windows host hands the handlers `C:\tmp\claude-501\...`
 * for the `/tmp/claude-501/...` the plugin asked about, and any other host puts its own working folder
 * before a Windows path, so the world compares them the POSIX way, from the drive on.
 */
const posix = (path: string) => path.replace(/^\/.*\/(?=[A-Za-z]:\\)/, '').replace(/^[A-Za-z]:(?=[\\/])/, '').replaceAll('\\', '/')

/**
 * Everything beneath the plugin: the session, its temp folder with the stored images, the prompt box,
 * ImageMagick, and what the engine draws. (A test cannot type into the box: the draft is there at start.)
 */
function world (
  on: On,
  { files = { '1.png': 300 * 1024 }, draft = '', env = {}, platform = 'linux', missing = [], refusing = {}, window = 'shown', readingMs = 0, pixels = [[RED, RED], [BLUE, BLUE]] }: { files?: Record<string, number>; platform?: 'linux' | 'macos' | 'windows'; draft?: string; env?: Record<string, string>; missing?: string[]; refusing?: Record<string, string>; window?: 'shown' | 'error'; readingMs?: number; pixels?: number[][] } = {}
) {
  const isWindows = platform === 'windows'
  const temp = isWindows ? posix(`${WIN_TEMP}\\claude`) : '/tmp/claude-501'
  const project = isWindows ? WIN_PROJECT : '-project-app'
  const root = isWindows ? 'C:\\project\\app' : '/project/app'
  const folder = `${temp}/${project}/s-1`
  // `error`, when set, is what reading the box fails with.
  const box: { text: string; error?: string } = { text: draft }
  const session = { id: 's-1' }
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, { TERM_PROGRAM: 'WarpTerminal', ...(isWindows && { OS: 'Windows_NT', TEMP: WIN_TEMP }), ...env })
  const runs: string[][] = []
  // The variables each run was given, in the order of `runs`.
  const runEnvs: Record<string, string>[] = []
  // What `wslpath -w` prints for a path of the WSL distro.
  const windowsPath = (path: string) => `\\\\wsl.localhost\\Ubuntu${path.replaceAll('/', '\\')}`
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: session.id }))
  on('session.root', () => ({ value: root }))
  on('session.cwd', () => ({ value: root }))
  on('prompt.read', () => (box.error !== undefined ? { deny: box.error } : { value: { text: box.text, cursor: box.text.length } }))
  on('process.run', async ($, e) => {
    // A slow machine takes seconds to start PowerShell from WSL.
    if (readingMs > 0 && e.argv[0] === 'powershell.exe') await clock.sleep(readingMs)
    // `uname` only tells the plugin which system it is on; Windows has neither it nor the others.
    if (isWindows && ['uname', 'id', 'mkdir'].includes(e.argv[0]!)) {
      runs.push([...e.argv])
      runEnvs.push({ ...e.init?.env })
      return { deny: `ENOENT: Command '${e.argv[0]}' not found` }
    }
    if (e.argv[0] === 'uname') return { value: { exitCode: 0, stdout: platform === 'macos' ? 'Darwin\n' : 'Linux\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    runs.push([...e.argv])
    runEnvs.push({ ...e.init?.env })
    // A program in `refusing` runs and fails, printing its text.
    const refusal = refusing[e.argv[0]!]
    if (refusal !== undefined) return { value: { exitCode: 1, stdout: '', stderr: refusal, isStdoutTruncated: false, isStderrTruncated: false } }
    const stdout = e.argv[0] === 'id' ? '501\n' : e.argv[0] === 'wslpath' ? `${windowsPath(e.argv[2]!)}\n` : ''
    return { value: { exitCode: missing.includes(e.argv[0]!) ? 127 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', ($, e) => ({ value: posix(e.path) === `${temp}/${project}/${session.id}/images` && session.id === 's-1' }))
  on('fs.list', ($, e) => ({
    value: posix(e.path) === `${folder}/images`
      ? Object.entries(files).map(([name, size]) => ({ name, kind: 'file' as const, size, mtimeMs: 0, isLink: false }))
      : posix(e.path) === temp
        ? [{ name: project, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }]
        : []
  }))
  on('fs.stat', ($, e) => ({ value: { kind: 'file' as const, size: files[posix(e.path).split('/').pop()!] ?? 0, mtimeMs: 0, isLink: false } }))
  on('fs.read', ($, e) => ({ value: { base64: posix(e.path).endsWith('.png') ? PNG : bmp(pixels).toBase64() } }))
  // Left to the engine, a write would land on the disk of the machine running the tests.
  on('fs.write', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  // The Windows window: prints `shown` (or an error), then a `.` every tenth of a second until it is ended.
  const windows: { argv: string[]; env: Record<string, string>; isEnded: boolean }[] = []
  on('process.spawn', async function * ($, e) {
    const opened = { argv: [...e.argv], env: { ...e.env }, isEnded: false }
    windows.push(opened)
    try {
      if (window === 'error') {
        yield { stream: 'stdout' as const, text: 'error: no display\r\n' }
        return { value: { code: 1, signal: null } }
      }
      yield { stream: 'stdout' as const, text: 'shown\r\n' }
      for (;;) {
        await clock.sleep(100)
        yield { stream: 'stdout' as const, text: '.\r\n' }
      }
    } finally {
      opened.isEnded = true
    }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  const logs: { text: string; to: string }[] = []
  on('ui.log', ($, e) => {
    logs.push({ text: e.text, to: e.to })
    return { value: undefined }
  })
  return { clock, runs, runEnvs, box, session, windows, logs }
}

type Drawn = RenderElement & { children?: Drawn[]; props?: { key?: string } }

/** The element keyed `key` in a drawn tree, props and all. */
function keyed (tree: RenderElement, key: string): Drawn | undefined {
  const node = tree as Drawn
  if (node.props?.key === key) return node
  for (const child of node.children ?? []) {
    if (typeof child === 'object') {
      const found = keyed(child, key)
      if (found) return found
    }
  }
  return undefined
}


// A picture far taller than wide: its card takes every row it is given, less the frame and caption.
const TALL = Array.from({ length: 200 }, () => [RED, RED])

const BAND = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const SCREEN = { columns: 120, rows: 40, isFullscreen: true }
type Shown = { first: number; last: number; of: number } | null

const startSession = ($: Engine) => $.session.start({ cwd: '/project/app', surface: 'terminal', isInteractive: true })
/** A session already running: past the rows it drew at its start, so each row drawn now is a new one. */
const running = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }) => {
  await startSession($)
  await clock.advance(1000)
}
const band = ($: Engine) => $.ui.mount({ plugin: 'image-preview', surface: 'terminal', component: 'AbovePrompt', props: BAND })
const sent = ($: Engine, text: string, onScreen?: Shown, requestId = 'm-1') =>
  $.ui.mount({
    plugin: 'image-preview',
    surface: 'terminal',
    component: 'UserMessage',
    requestId,
    props: { text, origin: { kind: 'composer' }, isExpanded: false, ...(onScreen !== undefined && { onScreen }) },
    viewport: SCREEN
  })
const reply = ($: Engine, requestId: string, onScreen: Shown, viewport = SCREEN) =>
  $.ui.mount({
    plugin: 'image-preview',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId,
    props: { text: 'Done.', isFirstOfReply: true, onScreen },
    viewport
  })
/** The pointer onto (or off) a chip: the band's, `chip:N`, or the one over a sent prompt's list, `sent:N`. */
const point = (ui: { pointer: (event: { type: 'enter' | 'leave'; x: number; y: number; in?: string }) => Promise<void> }, chip: string, type: 'enter' | 'leave' = 'enter') =>
  ui.pointer({ type, x: 0, y: 0, in: chip })

test('a pasted image gets a chip above the prompt, its card shown while the pointer is on it', async ($, on) => {
  const w = world(on, { draft: 'what is wrong here? [Image #1]' })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)

  expect(await ui.find({ key: 'chip:1' })).toMatchObject({ type: 'Client' })
  expect(await ui.find({ type: 'Text', text: '[Image #1]', in: 'chip:1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'hover to preview · click to open' })).toBeDefined()
  expect(await ui.find({ key: 'image-1' })).toBeUndefined()

  await point(ui, 'chip:1')
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster', props: { columns: 2, rows: 1 } })
  expect(await ui.find({ type: 'Text', text: /\[Image #1\] PNG · 300 KB/ })).toBeDefined()
  expect(w.runs).toContainEqual(['magick', ...LIMITS, `${FOLDER}/images/1.png`, '-resize', '800x800', `BMP3:${FOLDER}/image-preview/1.bmp`])

  await point(ui, 'chip:1', 'leave')
  expect(await ui.find({ key: 'image-1' })).toBeUndefined()
})

test('an image pasted while the session runs shows within half a second', async ($, on) => {
  const w = world(on)
  await startSession($)
  w.box.text = 'and now? [Image #1]'
  await w.clock.advance(500)
  const ui = await band($)
  expect(await ui.find({ key: 'chip:1' })).toBeDefined()
})

test('a poll of the prompt box that keeps failing puts its cause in the debug log once', async ($, on) => {
  const w = world(on)
  await startSession($)
  w.box.error = 'the box is gone'
  await w.clock.advance(2000)
  expect(w.logs.filter(line => line.text.includes('the box is gone'))).toEqual([{ text: expect.stringContaining('the box is gone'), to: 'debug' }])
})

test('off fullscreen, with no pointer to hover, the band is left as it was', async ($, on) => {
  const w = world(on, { draft: '[Image #1]' })
  await startSession($)
  await w.clock.settle()
  const ui = await $.ui.mount({
    plugin: 'image-preview',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: BAND,
    viewport: { columns: 120, rows: 40, isFullscreen: false }
  })
  expect(await ui.find({ key: 'engine' })).toBeDefined()
  expect(await ui.find({ key: 'chip:1' })).toBeUndefined()
})

test('with no image in the prompt the band is left as it was', async ($, on) => {
  world(on, { draft: 'just words' })
  await startSession($)
  const ui = await band($)
  expect(await ui.find({ key: 'engine' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'hover to preview · click to open' })).toBeUndefined()
})

test('an image the session never stored says so', async ($, on) => {
  const w = world(on, { files: {}, draft: '[Image #7]' })
  await startSession($)
  await w.clock.advance(5000)
  const ui = await band($)
  await point(ui, 'chip:7')
  expect(await ui.find({ type: 'Text', text: /^\[Image #7\] no preview: not stored in this session/ })).toBeDefined()
})

test('a session keeps the pixels of its last eight pictures, and reads an older one again when it is hovered', async ($, on) => {
  // Each picture's pixels take megabytes: a long session would hold them all.
  const ids = Array.from({ length: 10 }, (_, i) => i + 1)
  const w = world(on, { draft: ids.map(id => `[Image #${id}]`).join(' '), files: Object.fromEntries(ids.map(id => [`${id}.png`, 1024])) })
  await startSession($)
  await w.clock.settle()
  const reads = () => w.runs.filter(argv => argv.at(-1) === `BMP3:${FOLDER}/image-preview/1.bmp`).length
  expect(reads()).toBe(1)

  const ui = await band($)
  await point(ui, 'chip:1')
  await w.clock.settle()
  expect(reads()).toBe(2)
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })
})

test('sending the prompt takes the chips away, and the card a chip opened', async ($, on) => {
  const w = world(on, { draft: '[Image #1]' })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  await $.prompt.submit({ text: '[Image #1]', wait: false, origin: { kind: 'composer' } })
  expect(await ui.find({ key: 'chip:1' })).toBeUndefined()
  expect(await ui.find({ key: 'image-1' })).toBeUndefined()
})

test('under a sent prompt, each image the engine lists gets a chip over its row, unpainted', async ($, on) => {
  const w = world(on, { files: { '1.png': 2048, '2.jpg': 4096 } })
  await startSession($)
  const message = await sent($, 'compare [Image #2] with [Image #1]', { first: 0, last: 2, of: 3 })
  await w.clock.settle()

  expect(await message.find({ key: 'engine' })).toBeDefined()
  expect(keyed(await message.drawn(), 'listed-1')).toMatchObject({ props: { position: 'absolute', bottom: -1, left: 5 } })
  expect(keyed(await message.drawn(), 'listed-2')).toMatchObject({ props: { position: 'absolute', bottom: -2, left: 5 } })
  expect(await message.find({ key: 'sent:2' })).toMatchObject({ type: 'Client', props: { width: 10, height: 1 } })
  expect(await message.find({ type: 'Text', in: 'sent:2' })).toBeUndefined()
})

test('a sent prompt whose image was never stored is drawn as the engine draws it', async ($, on) => {
  const w = world(on, { files: {} })
  await startSession($)
  const message = await sent($, 'what about [Image #9]')
  await w.clock.advance(5000)
  expect(await message.drawn()).toMatchObject({ type: 'Box', props: { key: 'engine' } })
})

test('after /clear the new session reads its images again', async ($, on) => {
  const w = world(on, { draft: '[Image #1]' })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(await ui.find({ type: 'Text', text: /\[Image #1\] PNG/ })).toBeDefined()

  w.session.id = 's-2'
  await w.clock.advance(5000)
  expect(await ui.find({ key: 'image-1' })).toBeUndefined()
  await point(ui, 'chip:1', 'leave')
  await point(ui, 'chip:1')
  expect(await ui.find({ type: 'Text', text: /^\[Image #1\] no preview: can't find this session's image folder/ })).toBeDefined()
})

test('over a transcript that fills the rows, a chip opens its card above the prompt box, over no row of the transcript', async ($, on) => {
  // A card over the transcript would cut the text beside it.
  const w = world(on, { draft: 'and this? [Image #1]' })
  await startSession($)
  await w.clock.settle()
  const first = await sent($, 'hello', { first: 0, last: 19, of: 20 })
  const last = await reply($, 'a-1', { first: 0, last: 3, of: 4 })
  const ui = await band($)

  await point(ui, 'chip:1')
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })
  expect(await last.find({ key: 'float-1' })).toBeUndefined()
  expect(await first.find({ key: 'float-1' })).toBeUndefined()

  // New rows and a scroll leave it where it is.
  const after = await reply($, 'a-2', { first: 0, last: 5, of: 6 })
  await reply($, 'a-3', null)
  await w.clock.advance(500)
  expect(await after.find({ key: 'float-1' })).toBeUndefined()
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })

  await point(ui, 'chip:1', 'leave')
  expect(await ui.find({ key: 'image-1' })).toBeUndefined()
})

test('a sent prompt\'s chip opens its card just above the prompt, never over its own row', async ($, on) => {
  const w = world(on, { files: { '1.png': 2048 } })
  await running($, w.clock)
  await reply($, 'a-0', { first: 0, last: 14, of: 15 })
  const message = await sent($, 'look at [Image #1]', { first: 0, last: 2, of: 3 })
  const after = await reply($, 'a-1', { first: 0, last: 3, of: 4 })
  await w.clock.settle()

  await point(message, 'sent:1')
  expect(keyed(await message.drawn(), 'float-1')).toMatchObject({ props: { position: 'absolute', bottom: 2 } })
  expect(await after.find({ key: 'float-1' })).toBeUndefined()

  await point(message, 'sent:1', 'leave')
  expect(await message.find({ key: 'float-1' })).toBeUndefined()
})

test('a sent prompt at the top of the screen opens its card under its list, on the lowest row', async ($, on) => {
  const w = world(on, { files: { '1.png': 2048 } })
  await running($, w.clock)
  await reply($, 'a-0', null)
  const message = await sent($, 'look at [Image #1]', { first: 0, last: 2, of: 3 })
  const after = await reply($, 'a-1', { first: 0, last: 19, of: 20 })
  await w.clock.settle()

  await point(message, 'sent:1')
  expect(await message.find({ key: 'float-1' })).toBeUndefined()
  expect(keyed(await after.drawn(), 'float-1')).toMatchObject({ props: { position: 'absolute', bottom: 0 } })
})

test('scrolled until a sent prompt\'s rows are under the top row and only its list shows, the row under the list takes the pointer and opens the card below the list', async ($, on) => {
  const w = world(on, { files: { '1.png': 2048 }, pixels: TALL })
  await running($, w.clock)
  await reply($, 'a-0', null)
  const message = await sent($, 'look at [Image #1]', { first: 0, last: 1, of: 2 })
  const after = await reply($, 'a-1', { first: 0, last: 9, of: 10 })
  await w.clock.settle()
  expect(await after.find({ key: 'list:1' })).toBeUndefined()

  // The engine stops drawing the prompt, chips and all; the reply under it stays put on screen,
  // so the engine draws it no more either.
  await message.redraw({ text: 'look at [Image #1]', origin: { kind: 'composer' }, isExpanded: false, onScreen: null })
  expect(keyed(await after.drawn(), 'under-1')).toMatchObject({ props: { position: 'absolute', top: -1, left: 5 } })
  expect(await after.find({ key: 'list:1' })).toMatchObject({ type: 'Client' })

  await point(after, 'list:1')
  // The reply's ten rows hold the card, frame and caption included; the list's row above stays clear.
  expect(keyed(await after.drawn(), 'float-1')).toMatchObject({ props: { position: 'absolute', bottom: 0 } })
  expect(await after.find({ key: 'image-1' })).toMatchObject({ props: { rows: 10 - 3 } })
  expect(await message.find({ key: 'float-1' })).toBeUndefined()

  await point(after, 'list:1', 'leave')
  expect(await after.find({ key: 'float-1' })).toBeUndefined()

  // Back on screen, the prompt's own chip takes the pointer again.
  await message.redraw({ text: 'look at [Image #1]', origin: { kind: 'composer' }, isExpanded: false, onScreen: { first: 1, last: 1, of: 2 } })
  expect(await after.find({ key: 'list:1' })).toBeUndefined()
})

test('the card a sent prompt opened closes once the transcript moves: its chip may have left the pointer', async ($, on) => {
  const w = world(on, { files: { '1.png': 2048 } })
  await running($, w.clock)
  await reply($, 'a-0', { first: 0, last: 14, of: 15 })
  const message = await sent($, 'look at [Image #1]', { first: 0, last: 2, of: 3 })
  await w.clock.settle()
  await point(message, 'sent:1')
  expect(await message.find({ key: 'float-1' })).toBeDefined()

  await reply($, 'a-1', { first: 0, last: 3, of: 4 })
  await w.clock.advance(500)
  expect(await message.find({ key: 'float-1' })).toBeUndefined()
})

test('on a screen too short to float a card over the transcript, the band holds it', async ($, on) => {
  const w = world(on, { draft: '[Image #1]' })
  await startSession($)
  await w.clock.settle()
  const only = await reply($, 'a-1', { first: 0, last: 1, of: 2 }, { ...SCREEN, rows: 20 })
  const ui = await band($)
  await point(ui, 'chip:1')

  expect(await only.find({ key: 'float-1' })).toBeUndefined()
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })
})

test('a card writes every cell it covers, caption and all, so the transcript under it does not show through', async ($, on) => {
  const w = world(on, { draft: '[Image #1]' })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  const caption = await ui.find({ type: 'Text', text: /^\[Image #1\] PNG · 300 KB/ })
  expect(caption).toMatchObject({ text: '[Image #1] PNG · 300 KB'.padEnd(20) })
  // A picture two cells wide under a caption of 23: centered, the cells beside it written blank.
  expect((await ui.findAll({ type: 'Text', text: /^ +$/ })).map(found => found.text)).toEqual([' '.repeat(10), ' '.repeat(11)])
})

test('told the terminal draws pictures, the card sends it the picture as PNG bytes', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', env: { CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' } })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Image', props: { source: { png: PNG } } })
  expect(w.runs).toContainEqual(['magick', ...LIMITS, `${FOLDER}/images/1.png`, '-resize', '1024x1024>', `PNG:${FOLDER}/image-preview/1.view.png`])
})

test('moving from one listed image to the next opens the next card, the leave and the enter in either order', async ($, on) => {
  const w = world(on, { files: { '1.png': 2048, '2.png': 2048 } })
  await running($, w.clock)
  await reply($, 'a-0', { first: 0, last: 14, of: 15 })
  const message = await sent($, 'look at [Image #1] and [Image #2]', { first: 0, last: 2, of: 3 })
  await w.clock.settle()

  await point(message, 'sent:1')
  await point(message, 'sent:1', 'leave')
  await point(message, 'sent:2')
  expect(await message.find({ type: 'Text', text: /^\[Image #2\] PNG/ })).toBeDefined()

  await point(message, 'sent:1')
  await point(message, 'sent:2', 'leave')
  expect(await message.find({ type: 'Text', text: /^\[Image #1\] PNG/ })).toBeDefined()
})

test('rows a resumed session draws all at once, its prompts apart, are put back in the transcript\'s order', async ($, on) => {
  const w = world(on, { files: { '1.png': 2048 } })
  await startSession($)
  // As the engine draws a resumed session: its prompts first, then the rest.
  const first = await sent($, 'hello', { first: 0, last: 1, of: 2 }, 'm-1')
  const message = await sent($, 'look at [Image #1]', { first: 0, last: 2, of: 3 }, 'm-2')
  await reply($, 'a-1', { first: 0, last: 9, of: 10 })
  await $.ui.mount({ plugin: 'image-preview', surface: 'terminal', component: 'TurnDuration', requestId: 't-1', props: { word: 'Baked', durationMs: 1000, onScreen: { first: 0, last: 1, of: 2 } }, viewport: SCREEN })
  const after = await reply($, 'a-2', { first: 0, last: 1, of: 2 })
  await w.clock.advance(1000)
  expect(await first.find({ key: 'float-1' })).toBeUndefined()

  // The prompt's rows above it are the first prompt's and the first reply's: 15 rows, more than under it.
  await point(message, 'sent:1')
  expect(keyed(await message.drawn(), 'float-1')).toMatchObject({ props: { position: 'absolute', bottom: 2 } })
  expect(await after.find({ key: 'float-1' })).toBeUndefined()
})

test('a click on a chip opens the image in the desktop\'s viewer', async ($, on) => {
  const w = world(on, { draft: '[Image #1]' })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'chip:1' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'chip:1' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['xdg-open', `${FOLDER}/images/1.png`])
})

test('a sent prompt\'s [Image #N] on its first line takes the pointer and the click: hover shows, a click opens', async ($, on) => {
  const w = world(on, { files: { '1.png': 2048, '2.png': 2048 } })
  await running($, w.clock)
  await reply($, 'a-0', { first: 0, last: 14, of: 15 })
  const message = await sent($, 'look at [Image #1] and [Image #2] [Image #1]\nthen [Image #9]', { first: 0, last: 2, of: 3 })
  await w.clock.settle()
  expect(keyed(await message.drawn(), 'token-1')).toMatchObject({ props: { position: 'absolute', top: 1, left: 10 } })
  expect(keyed(await message.drawn(), 'token-2')).toMatchObject({ props: { top: 1, left: 25 } })
  expect(await message.findAll({ key: 'token:1' })).toHaveLength(1)

  await point(message, 'token:2')
  expect(keyed(await message.drawn(), 'float-2')).toBeDefined()

  await message.resize({ columns: 10, rows: 1, in: 'token:1' })
  await message.pointer({ type: 'down', x: 3, y: 0, button: 'left', in: 'token:1' })
  await message.pointer({ type: 'up', x: 30, y: 4, button: 'left', in: 'token:1' })
  await w.clock.settle()
  expect(w.runs.filter(argv => argv[0] === 'xdg-open')).toEqual([])

  await message.pointer({ type: 'down', x: 3, y: 0, button: 'left', in: 'token:1' })
  await message.pointer({ type: 'up', x: 3, y: 0, button: 'left', in: 'token:1' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['xdg-open', `${FOLDER}/images/1.png`])
})

test('an [Image #N] the first line wraps onto takes the pointer on the row it wrapped to', async ($, on) => {
  const w = world(on, { files: { '1.png': 2048 } })
  await running($, w.clock)
  // At 120 columns 23 words fill the first row; the next seven and the label go on the second.
  const message = await sent($, `${'word '.repeat(30)}[Image #1]`, { first: 0, last: 2, of: 3 })
  await w.clock.settle()
  expect(keyed(await message.drawn(), 'token-1')).toMatchObject({ props: { position: 'absolute', top: 2, left: 2 + 'word '.repeat(7).length } })
  expect(await message.find({ key: 'sent:1' })).toBeDefined()
})

test('an [Image #N] on a later line of a sent prompt takes the pointer, past the rows the first line wrapped to', async ($, on) => {
  const w = world(on, { files: { '1.png': 2048 } })
  await running($, w.clock)
  await reply($, 'a-0', { first: 0, last: 14, of: 15 })
  // Nine paths take two rows at 120 columns (five, then four): the second line is the third row.
  const paths = Array.from({ length: 9 }, (_, i) => `/tmp/iprepro/a${i + 1}.pdf`).join(' ')
  const message = await sent($, `${paths}\nчто за цвета тут [Image #1]`, { first: 0, last: 3, of: 4 })
  await w.clock.settle()
  expect(keyed(await message.drawn(), 'token-1')).toMatchObject({ props: { position: 'absolute', top: 3, left: 2 + 'что за цвета тут '.length } })

  await point(message, 'token:1')
  expect(keyed(await message.drawn(), 'float-1')).toBeDefined()
})

test('where the engine drew the prompt on other rows than the wrap counts, no [Image #N] takes the pointer', async ($, on) => {
  const w = world(on, { files: { '1.png': 2048 } })
  await running($, w.clock)
  const message = await sent($, `${'word '.repeat(30)}[Image #1]`, { first: 0, last: 3, of: 4 })
  await w.clock.settle()
  expect(await message.find({ key: 'token:1' })).toBeUndefined()
  expect(await message.find({ key: 'sent:1' })).toBeDefined()
})

test('a prompt the engine drew first under a stand-in id counts once: the card above it fits the rows there', async ($, on) => {
  const w = world(on, { files: { '1.png': 2048 }, pixels: TALL })
  await running($, w.clock)
  await reply($, 'a-0', { first: 0, last: 9, of: 10 })
  // The engine draws a sent prompt as `placeholder` until it is stored, then under its own id.
  await sent($, 'look at [Image #1]', { first: 0, last: 2, of: 3 }, 'placeholder')
  const message = await sent($, 'look at [Image #1]', { first: 0, last: 2, of: 3 })
  await w.clock.settle()

  await point(message, 'sent:1')
  // Ten rows of the reply, four of the logo and one spare: the placeholder's three are not there.
  expect(await message.find({ key: 'image-1' })).toMatchObject({ props: { rows: 15 - 3 } })
})

test('a tool group the engine drew under its tool\'s id until the turn ended counts once', async ($, on) => {
  const w = world(on, { files: { '1.png': 2048 }, pixels: TALL })
  await running($, w.clock)
  const group = (requestId: string) => $.ui.mount({ plugin: 'image-preview', surface: 'terminal', component: 'ToolGroup', requestId, props: { calls: [], isActive: false, isExpanded: false, onScreen: { first: 0, last: 3, of: 4 } }, viewport: SCREEN })
  await group('collapsed-toolu_01Ab')
  await group('collapsed-5f0c2b1e')
  await $.ui.mount({ plugin: 'image-preview', surface: 'terminal', component: 'TurnDuration', requestId: 't-1', props: { word: 'Baked', durationMs: 1000, onScreen: { first: 0, last: 1, of: 2 } }, viewport: SCREEN })
  const message = await sent($, 'look at [Image #1]', { first: 0, last: 2, of: 3 })
  await w.clock.settle()

  await point(message, 'sent:1')
  // Four rows of the group, two of the turn's length, four of the logo and one spare.
  expect(await message.find({ key: 'image-1' })).toMatchObject({ props: { rows: 11 - 3 } })
})

test('in Ghostty the terminal draws the picture itself, from the stored PNG', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', env: { TERM_PROGRAM: 'ghostty', TERM: 'xterm-ghostty' } })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Image', props: { source: { file: `${FOLDER}/images/1.png`, format: 'png' } } })
})

test('in Ghostty inside tmux, which passes no pictures through, the card is painted in cells', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', env: { TERM_PROGRAM: 'ghostty', TERM: 'tmux-256color', TMUX: '/tmp/tmux-501/default,4242,0' } })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })
})

test('a JPEG is shrunk to a PNG beside the cache for the terminal to draw', async ($, on) => {
  const w = world(on, { files: { '1.jpg': 4096 }, draft: '[Image #1]', env: { TERM: 'xterm-kitty' } })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(w.runs).toContainEqual(['magick', ...LIMITS, `${FOLDER}/images/1.jpg`, `PNG:${FOLDER}/image-preview/1.png`])
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Image', props: { source: { file: `${FOLDER}/image-preview/1.png` } } })
})

test('with ImageMagick 6 alone, convert reads the picture', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', missing: ['magick'] })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })
  expect(w.runs).toContainEqual(['convert', ...LIMITS, `${FOLDER}/images/1.png`, '-resize', '800x800', `BMP3:${FOLDER}/image-preview/1.bmp`])
})

test('without ImageMagick the card says what it needs', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', missing: ['magick', 'convert'] })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(await ui.find({ type: 'Text', text: /^\[Image #1\] no preview: needs ImageMagick to read it/ })).toBeDefined()
})

test('ImageMagick that runs and fails says what it said, not that it is missing', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', missing: ['convert'], refusing: { magick: "magick: no decode delegate for this image format `HEIC' @ error/constitute.c/ReadImage/746.\n" } })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(await ui.find({ type: 'Text', text: /^\[Image #1\] no preview: magick can't read it: no decode delegate for this image format `HEIC'/ })).toBeDefined()
})

test('a cache folder that can\'t be made is named as the cause', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', refusing: { mkdir: `mkdir: ${FOLDER}/image-preview: Permission denied\n` } })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(await ui.find({ type: 'Text', text: /^\[Image #1\] no preview: can't create the cache folder: Permission denied/ })).toBeDefined()
})

test('a session whose image folder is not found says so, not that the image was never stored', async ($, on) => {
  const w = world(on, { draft: '[Image #1]' })
  w.session.id = 's-9'
  await startSession($)
  await w.clock.advance(5000)
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(await ui.find({ type: 'Text', text: /^\[Image #1\] no preview: can't find this session's image folder/ })).toBeDefined()
})

for (const [platform, program, file] of [['macos', 'open', `${FOLDER}/images/1.png`], ['windows', 'explorer.exe', `${WIN_FOLDER}\\images\\1.png`]] as const) {
  test(`on ${platform} a click opens the image with the system's own program`, async ($, on) => {
    const w = world(on, { draft: '[Image #1]', platform })
    await startSession($)
    await w.clock.settle()
    const ui = await band($)
    await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'chip:1' })
    await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'chip:1' })
    await w.clock.settle()
    expect(w.runs).toContainEqual([program, file])
    expect(w.runs.filter(argv => argv[0] === 'xdg-open')).toEqual([])
  })
}

test('on Windows the session\'s images are under %TEMP%, and Windows itself reads the picture', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', platform: 'windows', missing: ['magick'], env: SSH })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })
  const read = w.runs.findIndex(argv => argv[0] === 'powershell.exe')
  expect(w.runs[read]!.slice(0, 6)).toEqual(POWERSHELL)
  expect(w.runEnvs[read]).toMatchObject({
    IMAGE_PREVIEW_FILE: `${WIN_FOLDER}\\images\\1.png`,
    IMAGE_PREVIEW_OUT_DIR: `${WIN_FOLDER}\\image-preview`,
    IMAGE_PREVIEW_OUT_NAME: '1.bmp',
    IMAGE_PREVIEW_FORMAT: 'bmp',
    IMAGE_PREVIEW_SIDE: '800'
  })
  // Windows has no `id`, `mkdir` or `uname`, and its `convert` is a disk tool.
  expect(w.runs.filter(argv => ['id', 'mkdir', 'uname', 'convert'].includes(argv[0]!))).toEqual([])
})

test('a prompt a resumed session draws before its start has told the system waits to learn it', async ($, on) => {
  const w = world(on, { platform: 'windows', missing: ['magick'] })
  const message = await sent($, 'look [Image #1]', { first: 0, last: 3, of: 4 })
  await startSession($)
  await w.clock.advance(1000)
  await w.clock.settle()
  await point(message, 'sent:1')
  await w.clock.advance(100)
  expect(w.windows.map(opened => opened.env.IMAGE_PREVIEW_FILE)).toEqual([`${WIN_FOLDER}\\images\\1.png`])
  // Asked the Linux way, Windows has no answer.
  expect(w.runs.filter(argv => ['id', 'mkdir', 'uname', 'convert'].includes(argv[0]!))).toEqual([])
})

test('a picture still being read when a resumed session starts is kept, not dropped as another session\'s', async ($, on) => {
  const w = world(on, { env: WSL, missing: ['magick', 'convert'], readingMs: 3000 })
  const message = await sent($, 'look [Image #1]', { first: 0, last: 3, of: 4 })
  await startSession($)
  await w.clock.advance(5000)
  await w.clock.settle()
  expect(keyed(await message.drawn(), 'sent:1')).toBeDefined()
})

test('a reading the reloaded plugin left unfinished is read again, whatever the old one wrote down', async ($, on) => {
  const w = world(on)
  // The module before the reload was still reading when it was unloaded, and wrote its failure
  // over the empty state the new one starts with.
  on('state.set', { plugin: 'image-preview', key: 'pictures' }, ($, e, next) => {
    const change = e as typeof e & { value: Record<string, unknown> }
    return next(Object.keys(change.value).length === 0 ? { ...change, value: { 1: { error: 'the read was cut short' } } } : e)
  })
  await startSession($)
  await w.clock.settle()
  const message = await sent($, 'look [Image #1]', { first: 0, last: 3, of: 4 })
  await w.clock.settle()
  expect(keyed(await message.drawn(), 'sent:1')).toBeDefined()
})

test('a WebP, which GDI+ cannot read, goes through the codecs of Windows, for the card and for the window', () => {
  for (const script of [READER, WINDOWS]) {
    expect(script).toContain('BitmapDecoder')
    expect(script).toContain('= Open-Picture $env:IMAGE_PREVIEW_FILE')
  }
})

test("the window draws in the screen's own pixels, at the size it has on a screen at 100%", () => {
  // A process Windows takes for one that knows no scale gets its window stretched, the picture
  // blurred: on a screen at 200% an 800-pixel picture went out as 1600 pixels drawn from 800.
  const aware = WINDOWS.indexOf('[ImagePreviewPopup]::Sharp()')
  expect(aware).toBeGreaterThan(-1)
  expect(WINDOWS).toContain('SetProcessDpiAwarenessContext')
  for (const call of ['Cursor]::Position', 'Screen]::FromPoint', 'New-Object ImagePreviewPopup']) {
    expect(WINDOWS.indexOf(call)).toBeGreaterThan(aware)
  }
  expect(WINDOWS).toContain('$scale = [ImagePreviewPopup]::ScaleAt($cursor.X, $cursor.Y)')
  expect(WINDOWS).toContain('$largest = $largest * $scale')
})

test('on Windows with ImageMagick, magick reads the picture', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', platform: 'windows', env: SSH })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })
  expect(w.runs).toContainEqual(['magick', ...LIMITS, `${WIN_FOLDER}\\images\\1.png`, '-resize', '800x800', `BMP3:${WIN_FOLDER}\\image-preview\\1.bmp`])
})

test('on Windows the card opens in a window by the pointer, as under WSL', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', platform: 'windows', missing: ['magick'] })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  await w.clock.advance(100)
  expect(w.windows).toHaveLength(1)
  expect(w.windows[0]!.argv.slice(0, 6)).toEqual(POWERSHELL)
  expect(w.windows[0]!.env).toMatchObject({ IMAGE_PREVIEW_FILE: `${WIN_FOLDER}\\images\\1.png`, IMAGE_PREVIEW_SIZE: '800' })
  expect(await ui.find({ key: 'image-1' })).toBeUndefined()
  await point(ui, 'chip:1', 'leave')
  await w.clock.advance(200)
  expect(w.windows[0]!.isEnded).toBe(true)
})

test('on a Mac without ImageMagick, sips reads the picture', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', platform: 'macos', missing: ['magick', 'convert'] })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })
  expect(w.runs).toContainEqual(['sips', '-s', 'format', 'bmp', '-Z', '800', `${FOLDER}/images/1.png`, '--out', `${FOLDER}/image-preview/1.bmp`])
})

test('under WSL without ImageMagick, Windows reads the picture, its paths crossing over through WSLENV', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', env: { WSL_DISTRO_NAME: 'Ubuntu', WSLENV: 'WT_SESSION', ...SSH }, missing: ['magick', 'convert'] })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })
  const read = w.runs.findIndex(argv => argv[0] === 'powershell.exe')
  expect(w.runs[read]!.slice(0, 6)).toEqual(POWERSHELL)
  expect(w.runEnvs[read]).toMatchObject({
    IMAGE_PREVIEW_FILE: `${FOLDER}/images/1.png`,
    IMAGE_PREVIEW_OUT_DIR: `${FOLDER}/image-preview`,
    IMAGE_PREVIEW_OUT_NAME: '1.bmp',
    WSLENV: 'WT_SESSION:IMAGE_PREVIEW_FILE/p:IMAGE_PREVIEW_OUT_DIR/p:IMAGE_PREVIEW_OUT_NAME:IMAGE_PREVIEW_FORMAT:IMAGE_PREVIEW_SIDE'
  })
})

test('under WSL a click opens the image in Windows\' viewer', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', env: { WSL_DISTRO_NAME: 'Ubuntu' } })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'chip:1' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'chip:1' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['explorer.exe', `\\\\wsl.localhost\\Ubuntu${FOLDER.replaceAll('/', '\\')}\\images\\1.png`])
  expect(w.runs.filter(argv => argv[0] === 'xdg-open')).toEqual([])
})


test('under WSL the card opens in a Windows window by the pointer, its variables crossing over through WSLENV', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', env: WSL })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  await w.clock.advance(100)

  expect(w.windows).toHaveLength(1)
  expect(w.windows[0]!.argv.slice(0, 6)).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
  expect(w.windows[0]!.env).toMatchObject({ IMAGE_PREVIEW_FILE: `${FOLDER}/images/1.png`, IMAGE_PREVIEW_SIZE: '800', WSLENV: 'WT_SESSION:IMAGE_PREVIEW_FILE/p:IMAGE_PREVIEW_SIZE:IMAGE_PREVIEW_LIFE' })
  expect(await ui.find({ key: 'image-1' })).toBeUndefined()

  // The pointer has left: the program ends at its next line.
  await point(ui, 'chip:1', 'leave')
  await w.clock.advance(200)
  expect(w.windows[0]!.isEnded).toBe(true)
})

test('under WSL moving from one image to the next ends the first window and opens the next', async ($, on) => {
  const w = world(on, { draft: '[Image #1] [Image #2]', files: { '1.png': 2048, '2.png': 2048 }, env: WSL })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  await w.clock.advance(100)
  await point(ui, 'chip:1', 'leave')
  await point(ui, 'chip:2')
  await w.clock.advance(300)
  expect(w.windows.map(opened => [opened.env.IMAGE_PREVIEW_FILE, opened.isEnded])).toEqual([[`${FOLDER}/images/1.png`, true], [`${FOLDER}/images/2.png`, false]])
})

test('under WSL a sent prompt\'s chip opens the window too, and a click ends it', async ($, on) => {
  const w = world(on, { env: WSL })
  await running($, w.clock)
  const message = await sent($, 'look [Image #1]', { first: 0, last: 3, of: 4 })
  await w.clock.settle()
  await point(message, 'sent:1')
  await w.clock.advance(100)
  expect(w.windows).toHaveLength(1)
  expect(keyed(await message.drawn(), 'float-1')).toBeUndefined()

  await message.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'sent:1' })
  await message.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'sent:1' })
  await w.clock.advance(200)
  expect(w.windows[0]!.isEnded).toBe(true)
})

test('under WSL with no window to be had, the terminal draws the cards for five minutes, and then a window is tried again', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', env: WSL, window: 'error' })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  await w.clock.advance(100)
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })

  await point(ui, 'chip:1', 'leave')
  await point(ui, 'chip:1')
  expect(w.windows).toHaveLength(1)
  // Claude Code puts the plugin's name before the line itself.
  expect(w.logs.filter(line => line.text.startsWith('no window ('))).toEqual([{ text: expect.stringContaining('the terminal draws the cards'), to: 'debug' }])

  // A failure may pass: five minutes on, a window is tried again.
  await point(ui, 'chip:1', 'leave')
  await w.clock.advance(5 * 60 * 1000)
  await point(ui, 'chip:1')
  await w.clock.advance(100)
  expect(w.windows).toHaveLength(2)
})

test('under WSL over SSH the window would open on another desktop: the terminal draws the card', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', env: { ...WSL, SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22' } })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(w.windows).toHaveLength(0)
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })
})

test('off WSL no window is tried: the terminal draws the card', async ($, on) => {
  const w = world(on, { draft: '[Image #1]' })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  await w.clock.advance(100)
  expect(w.windows).toHaveLength(0)
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })
})
