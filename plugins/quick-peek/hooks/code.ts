// A code or text file is shown by its lines, anything else by a card without them. It is told by
// its name; the engine colors the lines (Code, by the file's path).
import { nameOf } from './paths'

/** What the card shows of a file: its lines from `first` on, as written. */
export type Excerpt = { first: number; source: string; rows: number }

// Lines shown before the one the path names (a third of the card at most), what a tab becomes,
// and the longest line kept.
const CONTEXT = 3
const TAB = '  '
const LINE_CHARS = 240

const EXTENSIONS = new Set(('js mjs cjs jsx ts mts cts tsx json jsonc json5 jsonl html htm xhtml xml plist vue svelte astro ' +
  'css scss sass less md markdown mdx py pyi rb go rs lua c h cpp cc cxx hpp cs java kt kts swift dart scala php m mm zig ' +
  'sh bash zsh fish yml yaml toml ini cfg conf properties env sql txt text log csv tsv nix kdl service timer patch diff').split(' '))
const NAMES = new Set(['dockerfile', 'containerfile', 'makefile', 'gnumakefile', 'gemfile', 'rakefile', '.bashrc', '.zshrc',
  '.profile', '.gitignore', '.dockerignore', '.npmignore', '.prettierignore', '.gitattributes', '.editorconfig', '.npmrc',
  '.nvmrc', 'license', 'codeowners', 'procfile'])

/** Whether the file is code or text, by its name. An SVG is a picture, not text. */
export function isText (path: string) {
  const name = nameOf(path).toLowerCase()
  if (NAMES.has(name) || name.startsWith('.env') || name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return true
  const dot = name.lastIndexOf('.')
  return dot > 0 && EXTENSIONS.has(name.slice(dot + 1))
}

/**
 * `rows` lines of `text`: the first ones, or from a few before `line`. Tabs become spaces, the
 * shared indent is dropped, a long line is cut. Nothing for an empty file or for what is not text
 * (a NUL).
 */
export function excerptOf (text: string, line: number | undefined, rows: number): Excerpt | undefined {
  if (text.trim() === '' || text.includes('\u0000') || (text.slice(0, 4096).match(/�/g)?.length ?? 0) > 8) return undefined
  const all = text.split(/\r?\n/)
  if (all.length > 1 && all.at(-1) === '') all.pop()
  const mark = line !== undefined && line >= 1 && line <= all.length ? line : 0
  const first = mark > 0 ? Math.max(1, Math.min(mark - Math.min(CONTEXT, Math.floor(rows / 3)), all.length - rows + 1)) : 1
  const shown = all.slice(first - 1, first - 1 + rows).map(row => row.replaceAll('\t', TAB).trimEnd())
  while (shown.length > 1 && shown.at(-1) === '' && first + shown.length - 1 !== mark) shown.pop()
  const indent = Math.min(...shown.filter(row => row !== '').map(row => row.length - row.trimStart().length))
  return { first, source: shown.map(row => row.slice(indent).slice(0, LINE_CHARS)).join('\n'), rows: shown.length }
}
