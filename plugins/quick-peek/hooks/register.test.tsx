// Mod tests, run against the engine itself: `claude plugin test .`
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { excerptOf, isText } from './code'
import { blocks, inline, items, wrap } from './markdown'
import { lineOf, pathOfSpan, pathsIn, resolve } from './paths'

const VIDEO = '/Users/ana/videos/borrador.mp4'
const FOLDER = '/Users/ana/videos'
const README = '/project/app/README.md'
const SOURCE = '/project/app/src/app.ts'
const WIN_HOME = 'C:\\Users\\ana'
const WIN_ROOT = 'C:\\project\\app'
const WIN_VIDEO = 'C:\\Users\\ana\\videos\\borrador.mp4'
const WIN_README = 'C:\\project\\app\\README.md'
const WIN_SOURCE = 'C:\\project\\app\\src\\app.ts'
const SCRIPT = '/Users/ana/bin/deploy.command'
const BINARY = '/project/app/target/release/app'
const WIN_SETUP = 'C:\\Users\\ana\\setup.exe'
const ENV = '/project/app/.env'
const CODE = ['import { run } from \'./run\'', '', '// Starts it', 'export async function start (port: number) {', '  const server = await run(port)', '  return server', '}', ''].join('\n')
const SCREEN = { columns: 60, rows: 40, isFullscreen: true }

/**
 * Everything beneath the plugin: the session (its folder lost when `cwdError` is given), the files that
 * are there, the programs it runs (those in `failing` exit 1), what the engine draws, and the lines
 * the plugin logs.
 */
function world (on: On, { env = {}, cwd, cwdError, failing = [], platform = 'linux' }: { env?: Record<string, string>; cwd?: string; cwdError?: string; failing?: string[]; platform?: 'linux' | 'macos' | 'windows' | 'wsl' } = {}) {
  const clock = mock.clock(on, { now: 0 })
  const isWindows = platform === 'windows'
  // Windows names the home folder in USERPROFILE and the system in OS; it has no HOME.
  mock.env(on, { ...(isWindows ? { USERPROFILE: WIN_HOME, OS: 'Windows_NT' } : { HOME: '/Users/ana' }), ...(platform === 'wsl' && { WSL_DISTRO_NAME: 'Ubuntu' }), ...env })
  const there: Record<string, 'file' | 'dir'> = isWindows
    ? { [WIN_VIDEO]: 'file', [WIN_README]: 'file', [WIN_SOURCE]: 'file', [WIN_SETUP]: 'file' }
    : { [VIDEO]: 'file', [FOLDER]: 'dir', [README]: 'file', [SOURCE]: 'file', [SCRIPT]: 'file', [BINARY]: 'file', [ENV]: 'file' }
  const root = isWindows ? WIN_ROOT : '/project/app'
  const runs: string[][] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => (cwdError !== undefined ? { deny: cwdError } : { value: cwd ?? root }))
  on('session.root', () => ({ value: root }))
  on('process.run', ($, e) => {
    // `uname` only tells the plugin which system it is on; Windows has none.
    if (e.argv[0] === 'uname') {
      if (isWindows) return { deny: 'ENOENT: uname' }
      return { value: { exitCode: 0, stdout: platform === 'macos' ? 'Darwin\n' : 'Linux\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    runs.push([...e.argv])
    const stdout = e.argv[0] === 'wslpath' ? `\\\\wsl.localhost\\Ubuntu${e.argv[2]!.replaceAll('/', '\\')}\n` : ''
    return { value: { exitCode: failing.includes(e.argv[0]!) ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // A host that is not Windows takes a Windows path for a relative one and puts its own working
  // folder before it: the world looks at the path the plugin asked about.
  const asked = (path: string) => path.replace(/^\/.*\/(?=[A-Za-z]:\\)/, '')
  on('fs.stat', ($, e) => {
    const path = asked(e.path)
    const kind = there[path]
    if (!kind) return { deny: `ENOENT: ${path}` }
    return { value: { kind, size: path === SOURCE || path === WIN_SOURCE ? CODE.length : path === ENV ? 29 : 12 * 1024 * 1024, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const path = asked(e.path)
    if (path === SOURCE || path === WIN_SOURCE) return { value: CODE }
    if (path === ENV) return { value: 'API_TOKEN=sk-live-0123456789\n' }
    return { deny: `ENOENT: ${e.path}` }
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
  return { clock, runs, logs }
}

const startSession = ($: Engine, cwd = '/project/app') => $.session.start({ cwd, surface: 'terminal', isInteractive: true })
const reply = ($: Engine, text: string, viewport: { columns: number; rows: number; isFullscreen: boolean } = SCREEN) =>
  $.ui.mount({ plugin: 'quick-peek', surface: 'terminal', component: 'AssistantMessage', requestId: 'a-1', props: { text, isFirstOfReply: true }, viewport })

test('finds absolute, home, relative and bare paths, and cuts what a sentence adds', () => {
  const found = (text: string) => pathsIn(text).map(({ start, end, target }) => [text.slice(start, end), target])
  expect(found('Lo dejé en /Users/ana/x.mp4. Y en ~/notas.md, ¿vale?')).toEqual([['/Users/ana/x.mp4', '/Users/ana/x.mp4'], ['~/notas.md', '~/notas.md']])
  expect(found('Mira src/app.ts:42 y README.md (la raíz).')).toEqual([['src/app.ts:42', 'src/app.ts'], ['README.md', 'README.md']])
  expect(found('see https://example.com/a/b.html and/or 1/2')).toEqual([['and/or', 'and/or'], ['1/2', '1/2']])
  expect(found('a word, then this')).toEqual([])
  expect(pathOfSpan('~/My Videos/a b.mp4')).toBe('~/My Videos/a b.mp4')
  expect(pathOfSpan('npm run build')).toBeUndefined()
  expect(resolve('../b/./c.txt', '/project/app', '/Users/ana')).toBe('/project/b/c.txt')
  expect(resolve('~/x', '/project/app', '/Users/ana')).toBe('/Users/ana/x')
})

test('a path with a line names it; a file of code or text is known by its name', () => {
  expect(lineOf('src/app.ts:42')).toBe(42)
  expect(lineOf('src/app.ts:42:7.')).toBe(42)
  expect(lineOf('src/app.ts')).toBeUndefined()
  expect(['a.ts', 'b.tsx', 'c.html', 'd.css', 'e.json', 'f.md', 'Dockerfile', '.env.example', 'g.nix', 'h.kdl', 'i.svg', 'j.mp4', 'Makefile.bak'].map(isText)).toEqual([true, true, true, true, true, true, true, true, true, true, false, false, false])
})

test('a file that keeps secrets by its name shows no lines; its sample does', () => {
  expect(['.env', '.env.local', '.ENV.production', '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.pgpass'].map(isText)).toEqual(Array(8).fill(false))
  expect(['.env.example', '.env.sample', '.env.template', '.env.dist'].map(isText)).toEqual([true, true, true, true])
})

test('the card of a .env file names it and shows none of its lines', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await reply($, `Put the key in ${ENV}`)
  expect(await ui.find({ key: 'path:0:0' })).toMatchObject({ props: { props: { label: ENV, path: ENV } } })
  expect(await ui.find({ type: 'Text', text: / \.env · 29 B · / })).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(await ui.find({ text: /sk-live/ })).toBeUndefined()
})

/** Clicks the first link of `ui` with Alt held. */
async function altClick (ui: Awaited<ReturnType<typeof reply>>) {
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', alt: true, in: 'path:0:0' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', alt: true, in: 'path:0:0' })
}

test('an alt-click on a program or a script shows it in its folder instead of running it', async ($, on) => {
  const w = world(on, { platform: 'macos' })
  await startSession($)
  for (const path of [SCRIPT, BINARY]) {
    const ui = await reply($, `Built: ${path}`)
    await altClick(ui)
    await w.clock.settle()
    expect(w.runs).toContainEqual(['open', '-R', path])
    expect(w.runs).not.toContainEqual(['open', path])
    await ui.unmount()
  }
})

test('on Windows an alt-click on an .exe selects it in Explorer', async ($, on) => {
  const w = world(on, { platform: 'windows' })
  await startSession($, WIN_ROOT)
  const ui = await reply($, `Saved: \`${WIN_SETUP}\``)
  await altClick(ui)
  await w.clock.settle()
  expect(w.runs).toEqual([['explorer.exe', '/select,', WIN_SETUP]])
})

test('on Linux an alt-click on a script selects it in the file manager', async ($, on) => {
  const w = world(on)
  await startSession($)
  const ui = await reply($, `Built: ${SCRIPT}`)
  await altClick(ui)
  await w.clock.settle()
  expect(w.runs.find(argv => argv[0] === 'dbus-send')).toContain(`array:string:file://${SCRIPT}`)
  expect(w.runs.filter(argv => argv[0] === 'xdg-open')).toEqual([])
})

test('an alt-click on a folder opens it', async ($, on) => {
  const w = world(on)
  await startSession($)
  const ui = await reply($, `Saved in ${FOLDER}`)
  await altClick(ui)
  await w.clock.settle()
  expect(w.runs).toEqual([['xdg-open', FOLDER]])
})

test('a preview shows the first lines, or those around the one named, the shared indent cut', () => {
  expect(excerptOf(CODE, undefined, 3)).toEqual({ first: 1, rows: 3, source: "import { run } from './run'\n\n// Starts it" })
  expect(excerptOf(CODE, 5, 3)).toEqual({ first: 4, rows: 3, source: 'export async function start (port: number) {\n  const server = await run(port)\n  return server' })
  expect(excerptOf('    a\n\tb\n      c', undefined, 5)!.source).toBe('  a\nb\n    c')
  // Past its end, the line names nothing; a file with a NUL, or none, shows no lines.
  expect(excerptOf(CODE, 99, 3)).toMatchObject({ first: 1 })
  expect(excerptOf('G\u0000\u0000x', undefined, 3)).toBeUndefined()
  expect(excerptOf('\n  \n', undefined, 3)).toBeUndefined()
})

test('a preview marks each control character, which would cost the reply its links', () => {
  // Claude Code drops a whole drawing that holds a control character, an escape sequence included.
  expect(excerptOf('a\u001b[31mred\u001b[0m\n\u000cpage\rend\u007f', undefined, 5)!.source).toBe('a�[31mred�[0m\n�page�end�')
})

test('a reply with a control character in it keeps its links', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await reply($, 'Mira src/app.ts \u001b[1mya\u0007')
  expect(await ui.find({ key: 'card:0:0' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /�\[1mya�/ })).toBeDefined()
})

test('wraps as the engine does: a path that does not fit moves down; one longer than a row is cut after a folder', () => {
  const rows = (text: string, width: number) => wrap([{ text, style: {}, link: 0 }], width).map(row => row.map(run => run.text).join(''))
  expect(wrap(inline('see **this** and /a/very/long/path'), 16).map(row => row.map(run => run.text))).toEqual([['see ', 'this', ' and /a/'], ['very/long/path']])
  expect(rows('/Users/ana/videos/borrador-final.mp4', 20)).toEqual(['/Users/ana/videos/', 'borrador-final.mp4'])
  expect(rows('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
})

test('cuts a reply into blocks: a list of another kind is a list of its own; a fence stays whole', () => {
  const text = 'Intro:\n\n- a\n- b\n\n1. uno\n2. dos\n\n```\n/Users/ana/x\n\n```\nfin'
  expect(blocks(text).map(block => [block.kind, block.gap])).toEqual([['paragraph', 0], ['list', 1], ['list', 1], ['other', 1], ['paragraph', 0]])
  const [first] = items('- **A**: x\n  - nested\n- B\n  more')
  expect(first).toMatchObject({ text: '**A**: x', children: [{ text: 'nested' }] })
  expect(items('- B\n  more')[0]!.text).toBe('B\nmore')
})

test('a path that leads somewhere is a link; the blocks without one are the engine\'s Markdown', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await reply($, `## Hecho\n\nEl vídeo: \`${VIDEO}\`\n\nY ${FOLDER}/nada.mp4 no está.\n\n- uno\n- dos con README.md`)
  expect(await ui.find({ key: 'engine' })).toBeUndefined()
  expect(await ui.find({ type: 'Markdown', text: '## Hecho' })).toBeDefined()
  expect(await ui.find({ key: 'path:0:0' })).toMatchObject({ type: 'Client', props: { props: { label: VIDEO, path: VIDEO } } })
  expect(await ui.find({ type: 'Text', text: 'El vídeo: ' })).toBeDefined()
  // A path that is not there stays as written: its paragraph is the engine's.
  expect(await ui.find({ type: 'Markdown', text: /nada\.mp4 no está/ })).toBeDefined()
  expect(await ui.find({ key: 'path:1:0' })).toMatchObject({ props: { props: { label: 'README.md', path: README } } })
  expect(await ui.find({ type: 'Text', text: '-' })).toBeDefined()
})

test('after a `cd` into a folder of the project, a relative path leads from there or else from the project', async ($, on) => {
  world(on, { cwd: '/project/app/src' })
  await startSession($)
  const ui = await reply($, 'Mira `src/app.ts`, app.ts y README.md')
  expect(await ui.find({ key: 'path:0:0' })).toMatchObject({ props: { props: { label: 'src/app.ts', path: SOURCE } } })
  expect(await ui.find({ key: 'path:1:0' })).toMatchObject({ props: { props: { label: 'app.ts', path: SOURCE } } })
  expect(await ui.find({ key: 'path:2:0' })).toMatchObject({ props: { props: { label: 'README.md', path: README } } })
})

test('a reply the plugin fails to read is the engine\'s, and the cause goes to the debug log once', async ($, on) => {
  const w = world(on, { cwdError: 'the session has no folder' })
  await startSession($)
  const ui = await reply($, `Mira ${VIDEO}`)
  await ui.redraw({ text: `Mira ${VIDEO}`, isFirstOfReply: true })
  expect(await ui.find({ key: 'engine' })).toBeDefined()
  expect(w.logs.filter(line => line.text.includes('the session has no folder'))).toEqual([{ text: expect.stringContaining('the session has no folder'), to: 'debug' }])
})

test('a reply naming no path that is there is the engine\'s, and so is one off fullscreen', async ($, on) => {
  world(on)
  await startSession($)
  const missing = await reply($, 'Nada que ver en /no/existe.txt')
  expect(await missing.find({ key: 'engine' })).toBeDefined()
  await missing.unmount()
  expect(await (await reply($, `Mira ${VIDEO}`, { ...SCREEN, isFullscreen: false })).find({ key: 'engine' })).toBeDefined()
})

test('a path a row cannot hold is drawn in parts, each its own link', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await reply($, `Listo: ${VIDEO}`, { ...SCREEN, columns: 22 })
  expect(await ui.find({ key: 'path:0:0' })).toMatchObject({ props: { props: { label: '/Users/ana/', path: VIDEO } } })
  expect(await ui.find({ key: 'path:0:1' })).toMatchObject({ props: { props: { label: 'videos/borrador.mp4', path: VIDEO } } })
})

test('a click asks the file manager to select the path; an alt-click opens it', async ($, on) => {
  const w = world(on)
  await startSession($)
  const ui = await reply($, `Listo: ${VIDEO}`)
  await ui.resize({ columns: VIDEO.length, rows: 1, in: 'path:0:0' })
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await w.clock.settle()
  expect(w.runs.find(argv => argv[0] === 'dbus-send')).toContain(`array:string:file://${VIDEO}`)
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', alt: true, in: 'path:0:0' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', alt: true, in: 'path:0:0' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['xdg-open', VIDEO])
  // Let go away from where it went down, it is no click.
  const before = w.runs.length
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await ui.pointer({ type: 'up', x: 2, y: 5, button: 'left', in: 'path:0:0' })
  await w.clock.settle()
  expect(w.runs.slice(before)).toEqual([])
})

test('on macOS a click selects the path in Finder; an alt-click opens it', async ($, on) => {
  const w = world(on, { platform: 'macos' })
  await startSession($)
  const ui = await reply($, `Listo: ${VIDEO}`)
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['open', '-R', VIDEO])
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', alt: true, in: 'path:0:0' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', alt: true, in: 'path:0:0' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['open', VIDEO])
  // A stock Mac has neither program.
  expect(w.runs.filter(argv => argv[0] === 'xdg-open' || argv[0] === 'dbus-send')).toEqual([])
})

test('each path carries a card the terminal reveals over it', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await reply($, `Listo: ${VIDEO}`)
  expect(await ui.find({ key: 'card:0:0' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /borrador\.mp4 · 12\.0 MB · \d+[smhd] ago · click: show in file manager/ })).toBeDefined()
})

type Shown = { first: number; last: number; of: number }
const shownAt = ($: Engine, requestId: string, text: string, onScreen: Shown, viewport = SCREEN) =>
  $.ui.mount({ plugin: 'quick-peek', surface: 'terminal', component: 'AssistantMessage', requestId, props: { text, isFirstOfReply: true, onScreen }, viewport })
/** The card's rows from its path's row (negative above it), title and lines of code. */
async function cardRows (ui: Awaited<ReturnType<typeof shownAt>>) {
  const card = (await ui.findAll({ type: 'Box' })).find(box => box.props.position === 'absolute')!
  const code = await ui.find({ type: 'Code' })
  const lines = code ? String(code.props.source).split('\n').length : 0
  const top = card.props.top as number
  return { top, bottom: top + 1 + lines, lines }
}

test('the first reply at the top of the screen opens its card under the path, never over it', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await shownAt($, 'a-1', 'Mira src/app.ts', { first: 0, last: 0, of: 1 })
  expect(await cardRows(ui)).toEqual({ top: 1, bottom: 9, lines: 7 })
  // The rows drawn after it would paint over the card: it moves below them.
  await shownAt($, 'a-2', 'Nada que ver aquí', { first: 0, last: 1, of: 2 })
  expect(await cardRows(ui)).toEqual({ top: 3, bottom: 11, lines: 7 })
})

test('a card with room on neither side keeps its title under the path, off the logo', async ($, on) => {
  world(on)
  await startSession($)
  // A reply's one line under the logo of a screen 14 rows tall: the logo above, the prompt box below.
  const ui = await shownAt($, 'a-1', 'Mira src/app.ts', { first: 0, last: 0, of: 1 }, { ...SCREEN, rows: 14 })
  expect(await cardRows(ui)).toMatchObject({ top: 1, lines: 0 })
})

test('the last reply on a full screen keeps its card over the path, whole', async ($, on) => {
  world(on)
  await startSession($)
  await shownAt($, 'a-0', 'Nada que ver aquí', { first: 10, last: 37, of: 38 })
  const ui = await shownAt($, 'a-1', 'Mira src/app.ts', { first: 0, last: 0, of: 1 })
  expect(await cardRows(ui)).toEqual({ top: -8, bottom: 0, lines: 7 })
})

test('a card under its path lies over the rows drawn after it, whole', async ($, on) => {
  // Seen in Ghostty: the turn's "Churned for 0s" line and the next prompt, drawn after the reply,
  // painted over the card. The row under it draws the card again, over itself, shown with it.
  world(on)
  await startSession($)
  await shownAt($, 'a-0', 'Nada que ver aquí', { first: 7, last: 9, of: 10 })
  const ui = await shownAt($, 'a-1', 'Mira src/app.ts', { first: 0, last: 0, of: 1 })
  const below = await shownAt($, 'a-2', 'Nada que ver aquí', { first: 0, last: 29, of: 30 })
  expect(await cardRows(ui)).toEqual({ top: 1, bottom: 9, lines: 7 })
  const copy = (await below.findAll({ type: 'Box' })).find(box => box.props.position === 'absolute')!
  expect(copy.props.display).toBe('none')
  // From the foot of the row under the reply, 30 lines down from the path: the card's 8 rows start
  // one line under the path.
  expect(copy.props.bottom).toBe(30 + 1 - 1 - 8)
  // As wide as the reply, the card starts at its first column, past the bullet.
  expect(copy.props.left).toBe(2)
  expect(await below.find({ type: 'Code' })).toBeDefined()
})

test('as the rows above scroll away, a card that no longer fits over its path is drawn again shorter', async ($, on) => {
  world(on)
  await startSession($)
  const above = await shownAt($, 'a-0', 'Nada que ver aquí', { first: 0, last: 9, of: 10 })
  const ui = await shownAt($, 'a-1', 'Mira src/app.ts', { first: 0, last: 0, of: 1 })
  expect(await cardRows(ui)).toEqual({ top: -8, bottom: 0, lines: 7 })
  await above.redraw({ text: 'Nada que ver aquí', isFirstOfReply: true, onScreen: { first: 7, last: 9, of: 10 } })
  expect(await cardRows(ui)).toEqual({ top: -3, bottom: 0, lines: 2 })
})

test('after a /clear the rows that filled the screen are gone, and the card opens under the path', async ($, on) => {
  world(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await startSession($)
  await shownAt($, 'a-0', 'Nada que ver aquí', { first: 10, last: 37, of: 38 })
  await $.session.end({ reason: 'clear', sessionId: 's-1', resume: { id: 's-1' } })
  const ui = await shownAt($, 'a-1', 'Mira src/app.ts', { first: 0, last: 0, of: 1 })
  expect(await cardRows(ui)).toEqual({ top: 1, bottom: 9, lines: 7 })
})

test('the card of a file of code shows its first lines, colored by the engine', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await reply($, 'Mira src/app.ts y el vídeo ' + VIDEO)
  expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { path: SOURCE } })
  expect(await ui.find({ key: 'card:0:0' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /app\.ts · \d+ B · \d+[smhd] ago · click: show in file manager/ })).toBeDefined()
})

test('a card writes every cell it covers, in a light theme as in a dark one', async ($, on) => {
  // The transcript shows through every cell a card leaves unwritten, and an inverse title is a
  // black bar on a light theme. Lines on the terminal's own background run into the transcript, so
  // the card has the fill the theme gives a prompt.
  world(on)
  await startSession($)
  const ui = await reply($, 'Mira src/app.ts')
  const card = (await ui.findAll({ type: 'Box' })).find(box => box.props.position === 'absolute')!
  expect(card.props.backgroundColor).toBe('userMessageBackground')
  const width = card.props.width as number
  const title = await ui.find({ type: 'Text', text: /app\.ts · / })
  expect(title!.props.inverse).toBeUndefined()
  expect(title!.props.backgroundColor).toBe('subtle')
  // A title wider than the card is cut at its edge.
  expect(String(title!.text).length).toBeGreaterThanOrEqual(width)
  const gutter = await ui.find({ type: 'Text', text: /^ *1 \n/ })
  const code = await ui.find({ type: 'Code' })
  expect(code!.props.startLine).toBeUndefined()
  const numbers = String(gutter!.text).split('\n')
  const lines = String(code!.props.source).split('\n')
  expect(numbers.map(number => number.trim())).toEqual(['1', '2', '3', '4', '5', '6', '7'])
  expect(lines.map((line, i) => numbers[i]!.length + line.length)).toEqual(lines.map(() => width))
  expect(lines.map(line => line.trimEnd())).toEqual(CODE.trimEnd().split('\n'))
})


test('where no file manager answers, a click opens the folder the path is in', async ($, on) => {
  const w = world(on, { failing: ['dbus-send'] })
  await startSession($)
  const ui = await reply($, `Listo: ${VIDEO}`)
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['xdg-open', FOLDER])
})

test('a reply with a long run of punctuation is read in linear time', () => {
  // The rows are read while the reply is drawn: a slow reading holds the screen.
  const started = performance.now()
  expect(pathsIn(`see /${'.'.repeat(40000)}x`)).toHaveLength(1)
  expect(performance.now() - started).toBeLessThan(250)
})

test('finds the paths Windows writes: from a drive, with either slash, relative, from home', () => {
  const found = (text: string) => pathsIn(text).map(({ start, end, target }) => [text.slice(start, end), target])
  expect(found('Saved to C:\\Users\\ana\\x.mp4. And D:/work/notes.md, see?')).toEqual([['C:\\Users\\ana\\x.mp4', 'C:\\Users\\ana\\x.mp4'], ['D:/work/notes.md', 'D:/work/notes.md']])
  expect(found('Look at src\\app.ts:42 and .\\docs\\plan.md and ~\\notes.md')).toEqual([['src\\app.ts:42', 'src\\app.ts'], ['.\\docs\\plan.md', '.\\docs\\plan.md'], ['~\\notes.md', '~\\notes.md']])
  expect(pathOfSpan('C:\\My Videos\\a b.mp4')).toBe('C:\\My Videos\\a b.mp4')
  expect(pathOfSpan('C:\\project\\app\\src\\app.ts:12')).toBe('C:\\project\\app\\src\\app.ts')
  expect(lineOf('C:\\project\\app\\src\\app.ts:12')).toBe(12)
  expect(isText('C:\\project\\app\\src\\app.ts')).toBe(true)
  expect(isText('C:\\project\\app.ts\\clip.mp4')).toBe(false)
})

test('in a Windows folder a path lands the Windows way, whichever slash it was written with', () => {
  expect(resolve('src/app.ts', WIN_ROOT, WIN_HOME)).toBe(WIN_SOURCE)
  expect(resolve('src\\app.ts', WIN_ROOT, WIN_HOME)).toBe(WIN_SOURCE)
  expect(resolve('..\\b\\.\\c.txt', WIN_ROOT, WIN_HOME)).toBe('C:\\project\\b\\c.txt')
  expect(resolve('~/videos/borrador.mp4', WIN_ROOT, WIN_HOME)).toBe(WIN_VIDEO)
  expect(resolve('~\\videos\\borrador.mp4', WIN_ROOT, WIN_HOME)).toBe(WIN_VIDEO)
  expect(resolve('C:/project/app/README.md', 'D:\\work', WIN_HOME)).toBe(WIN_README)
  // No drive named: the working folder's.
  expect(resolve('\\project\\app\\README.md', WIN_ROOT, WIN_HOME)).toBe(WIN_README)
  // Off Windows a backslash is a character of a name like any other.
  expect(resolve('a\\b', '/project/app', '/Users/ana')).toBe('/project/app/a\\b')
})

test('on Windows a path is a link, its card named by the file, and a click selects it in Explorer; an alt-click opens it', async ($, on) => {
  const w = world(on, { platform: 'windows' })
  await startSession($, WIN_ROOT)
  const ui = await reply($, `Done: \`${WIN_VIDEO}\`\n\nAnd src/app.ts with README.md`)
  expect(await ui.find({ key: 'path:0:0' })).toMatchObject({ type: 'Client', props: { props: { label: WIN_VIDEO, path: WIN_VIDEO } } })
  expect(await ui.find({ key: 'path:1:0' })).toMatchObject({ props: { props: { label: 'src/app.ts', path: WIN_SOURCE } } })
  expect(await ui.find({ key: 'path:2:0' })).toMatchObject({ props: { props: { label: 'README.md', path: WIN_README } } })
  expect(await ui.find({ type: 'Text', text: / borrador\.mp4 · 12\.0 MB · .* · click: show in file manager / })).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { path: WIN_SOURCE } })

  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['explorer.exe', '/select,', WIN_VIDEO])
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', alt: true, in: 'path:0:0' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', alt: true, in: 'path:0:0' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['explorer.exe', WIN_VIDEO])
  expect(w.runs.filter(argv => argv[0] === 'xdg-open' || argv[0] === 'dbus-send' || argv[0] === 'open')).toEqual([])
})

test('under WSL a click selects the path in Windows\' Explorer, named the way Windows reaches the distro', async ($, on) => {
  const w = world(on, { platform: 'wsl' })
  await startSession($)
  const ui = await reply($, `Listo: ${VIDEO}`)
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await w.clock.settle()
  const windows = `\\\\wsl.localhost\\Ubuntu${VIDEO.replaceAll('/', '\\')}`
  expect(w.runs).toContainEqual(['explorer.exe', '/select,', windows])
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', alt: true, in: 'path:0:0' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', alt: true, in: 'path:0:0' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['explorer.exe', windows])
  expect(w.runs.filter(argv => argv[0] === 'xdg-open' || argv[0] === 'dbus-send')).toEqual([])
})
