// A picture a reply names is shown on its card where the terminal draws pictures (Ghostty and
// kitty): first written as a PNG no larger than a card needs, in the plugin's own temp folder, by
// sips on macOS or by ImageMagick. Elsewhere, and until it is written, the card shows the name,
// size and age alone.
import type { EngineInterface, FsStat } from 'claude-code'

import { nameOf } from './paths'
import { systemOf } from './system'

type Engine = EngineInterface

/** A picture as the terminal draws it: the PNG written of it, and that PNG's size in pixels. */
export type Picture = { file: string; width: number; height: number }

const EXTENSIONS = new Set('png jpg jpeg gif webp bmp tif tiff heic heif avif'.split(' '))
// The longer side written, in pixels: a card is at most a hundred columns wide.
const SIDE = 800
// A larger file is left alone: reading it would keep the machine busy for a card.
const MAX_BYTES = 64 * 1024 * 1024
// What ImageMagick may take to read a picture: a crafted one could otherwise fill the memory or
// the disk, or keep it busy for good.
const LIMITS = ['-limit', 'memory', '256MiB', '-limit', 'map', '512MiB', '-limit', 'area', '128MP', '-limit', 'disk', '1GiB', '-limit', 'time', '30']
const KEPT = 100
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// Per path, size and time of change: the picture, null where none could be written, or the
// writing under way.
const pictures = new Map<string, Picture | null | Promise<void>>()
let drawing: Promise<boolean> | undefined
let folder: Promise<string> | undefined
let written = 0

/** Forgets the pictures and what the terminal draws: a session starts, maybe in another terminal. */
export function forgetPictures () {
  pictures.clear()
  drawing = undefined
  folder = undefined
}

/** Whether the file is a picture by its name. */
export const isPicture = (path: string) => {
  const name = nameOf(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot > 0 && EXTENSIONS.has(name.slice(dot + 1))
}

/**
 * Whether the terminal draws pictures from a file: Ghostty and kitty. Inside tmux their variables
 * are still there, but tmux passes no pictures through.
 */
export function drawsPictures ($: Engine) {
  return (drawing ??= Promise.all([$.env.get('TERM_PROGRAM'), $.env.get('TERM'), $.env.get('KITTY_WINDOW_ID'), $.env.get('TMUX')])
    .then(([program, term, kittyWindow, tmux]) => tmux === undefined && (program === 'ghostty' || term === 'xterm-ghostty' || term === 'xterm-kitty' || kittyWindow !== undefined)))
}

/** `<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>/quick-peek`, made once. */
function folderOf ($: Engine) {
  return (folder ??= (async () => {
    const named = await $.env.get('CLAUDE_CODE_TMPDIR')
    const uid = (await $.process.run(['id', '-u'])).stdout.trim()
    const path = `${(named || '/tmp').replace(/\/+$/, '')}/claude-${uid}/quick-peek`
    if ((await $.process.run(['mkdir', '-p', path])).exitCode !== 0) throw new Error(`can't create ${path}`)
    return path
  })())
}

/** A PNG's width and height from its header; undefined for anything else. */
function sizeOfPng (bytes: Uint8Array) {
  if (bytes.length < 24 || PNG_SIGNATURE.some((byte, i) => bytes[i] !== byte)) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** Writes the picture at `path` as a PNG, by the first program that manages it. Null when none does. */
async function write ($: Engine, path: string): Promise<Picture | null> {
  const system = await systemOf($)
  if (system === 'windows') return null
  const out = `${await folderOf($)}/${++written}.png`
  const readers = [
    ...(system === 'macos' ? [['sips', '-s', 'format', 'png', '-Z', String(SIDE), path, '--out', out]] : []),
    // `[0]`: the first frame of an animation, or the first page of a TIFF.
    ...['magick', 'convert'].map(name => [name, ...LIMITS, `${path}[0]`, '-resize', `${SIDE}x${SIDE}>`, `PNG:${out}`])
  ]
  for (const argv of readers) {
    if ((await $.process.run(argv).catch(() => undefined))?.exitCode !== 0) continue
    const { base64 } = await $.fs.read(out, { as: 'bytes' })
    const size = sizeOfPng(Uint8Array.fromBase64(base64))
    return size && size.width > 0 && size.height > 0 ? { file: out, ...size } : null
  }
  return null
}

/**
 * The picture at `path` as the terminal draws it. Undefined while it is being written, and `ready`
 * is called once it is; null where it can't be.
 */
export function pictureAt ($: Engine, path: string, stat: FsStat, ready: () => void): Picture | null | undefined {
  if (stat.kind !== 'file' || stat.size > MAX_BYTES) return null
  const key = `${path}\n${stat.size}\n${stat.mtimeMs}`
  const known = pictures.get(key)
  if (known instanceof Promise) return undefined
  if (known !== undefined) return known
  if (pictures.size >= KEPT) pictures.delete(pictures.keys().next().value!)
  const writing = write($, path).catch(() => null).then(picture => {
    if (pictures.get(key) !== writing) return
    pictures.set(key, picture)
    if (picture) ready()
  })
  pictures.set(key, writing)
  return undefined
}

/**
 * The cells a picture of `width` by `height` pixels takes within `columns` by `rows`, a cell twice
 * as tall as it is wide.
 */
export function fit (width: number, height: number, columns: number, rows: number) {
  let wide = Math.max(1, columns)
  let tall = Math.max(1, Math.round((wide * height) / width / 2))
  if (tall > rows) {
    tall = Math.max(1, rows)
    wide = Math.max(1, Math.min(columns, Math.round((tall * 2 * width) / height)))
  }
  return { columns: wide, rows: tall }
}
