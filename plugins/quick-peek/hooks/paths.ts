// Finding the paths a text names: absolute (`/Users/…`, `C:\Users\…`), from home (`~/…`), relative
// (`./x`, `src/x.ts`, `README.md`), each with an optional `:line` or `:line:column` after it;
// Windows writes them with either slash. A path is only a candidate here: the hooks module links
// the ones that lead to a file or folder.

/** A path a text names: where it starts and ends in the text, and the path itself, `:line` cut. */
export type Found = { start: number; end: number; target: string }

// What a sentence puts after a path, and a line (and column) after a file.
const TRAILING = new Set('.,;:!?)]}>\'"»”’')
const LINE = /:\d+(?::\d+)?$/
// An address: never a path, nor the paths inside it.
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()]+/gi
// From a drive; absolute, from home or explicitly relative; a relative path with a folder in it; a
// file name with an extension. None starts inside a word, an address or another path.
const CANDIDATE = new RegExp(
  [
    String.raw`[A-Za-z]:[\\/][^\s\`'"<>()[\]{}|*]+`,
    String.raw`(?:~|\.{1,2})?\/[^\s\`'"<>()[\]{}|*]+`,
    String.raw`(?:~|\.{1,2})\\[^\s\`'"<>()[\]{}|*]+`,
    String.raw`[\w@+-][\w@.+-]*(?:[\\/][\w@.+-]+)+[\\/]?`,
    String.raw`[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,9}`
  ].map(source => `(?<![\\w/.~:\\\\@-])(?:${source})(?::\\d+(?::\\d+)?)?`).join('|'),
  'g'
)
// A whole inline code span that is a path: it may hold spaces when it starts as a path does.
const SPAN = /^(?:(?:~|\.{1,2})?\/|(?:~|\.{1,2})\\|[A-Za-z]:[\\/])[^\n`]*[^\s`]$/
// How a Windows path starts, and so how a Windows working folder is known.
const DRIVE = /^[A-Za-z]:[\\/]/

/**
 * `text` less what a sentence puts after a path. Walked back from the end: a pattern anchored at
 * the end would try a long run of these from every place in it.
 */
function trimmed (text: string) {
  let end = text.length
  while (end > 0 && TRAILING.has(text[end - 1]!)) end--
  return text.slice(0, end)
}

/** The path `found` names, with what a sentence or a line number adds after it cut; none when nothing is left. */
function clean (text: string) {
  const target = trimmed(trimmed(text).replace(LINE, ''))
  return /[\w~]/.test(target) && target !== '~' ? target : undefined
}

/** The line a path's text names after it (`src/x.ts:12`, `src/x.ts:12:5`), if it names one. */
export function lineOf (text: string) {
  const line = trimmed(text.trim()).match(LINE)?.[0]
  return line === undefined ? undefined : Number(line.slice(1).split(':')[0])
}

/** The paths named in plain text, in order. */
export function pathsIn (text: string): Found[] {
  const masked = text.replace(URL, match => ' '.repeat(match.length))
  const found: Found[] = []
  for (const match of masked.matchAll(CANDIDATE)) {
    const whole = match[0]
    const target = clean(whole)
    if (target === undefined) continue
    found.push({ start: match.index, end: match.index + trimmed(whole).length, target })
  }
  return found
}

/** The path an inline code span holds whole (`` `~/a b/c.mp4` `` or `` `src/x.ts:12` ``), if it holds one. */
export function pathOfSpan (code: string): string | undefined {
  const text = code.trim()
  if (SPAN.test(text)) return text.replace(LINE, '')
  const found = pathsIn(text)
  return found.length === 1 && found[0]!.start === 0 && found[0]!.end === text.length ? found[0]!.target : undefined
}

/**
 * Where `target` lands: home for `~`, the working folder for a relative path; `.` and `..`
 * folded, no trailing slash. A working folder on a drive makes it a Windows path: either slash
 * parts its folders, it is written with `\`, and one that names no drive is on that folder's.
 */
export function resolve (target: string, cwd: string, home: string | undefined) {
  const isWindows = DRIVE.test(cwd)
  let path = target
  if (path === '~' || path.startsWith('~/') || (isWindows && path.startsWith('~\\'))) {
    if (!home) return undefined
    path = home + path.slice(1)
  } else if (isWindows ? !DRIVE.test(path) && !/^[\\/]/.test(path) : !path.startsWith('/')) {
    path = `${cwd}/${path}`
  }
  const drive = !isWindows ? '' : DRIVE.test(path) ? path.slice(0, 2) : cwd.slice(0, 2)
  const parts: string[] = []
  for (const part of path.slice(DRIVE.test(path) && isWindows ? 2 : 0).split(isWindows ? /[\\/]/ : '/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return isWindows ? `${drive}\\${parts.join('\\')}` : `/${parts.join('/')}`
}

/** The name a path ends in, after its last slash of either kind. */
export const nameOf = (path: string) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
