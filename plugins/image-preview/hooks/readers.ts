// The programs that read a pasted picture and write it as a BMP or a PNG the plugin can use.
import type { EngineInterface } from 'claude-code'

import type { System } from './system'
import { readerCommand } from './window'

type Engine = EngineInterface

// What reads a picture, tried in this order: magick is ImageMagick 7 and convert ImageMagick 6
// (Ubuntu has the latter, NixOS both; on Windows `convert` is a disk tool), then what the system
// has of its own, sips on macOS and PowerShell with System.Drawing on Windows and under WSL.
export type Tool = 'magick' | 'convert' | 'sips' | 'powershell'
const TOOLS: Record<System, Tool[]> = {
  linux: ['magick', 'convert'],
  macos: ['magick', 'convert', 'sips'],
  windows: ['magick', 'powershell'],
  wsl: ['magick', 'convert', 'powershell']
}
// What ImageMagick may take to read a pasted picture: a crafted one could otherwise fill the
// memory or the disk, or keep it busy for good.
const LIMITS = ['-limit', 'memory', '256MiB', '-limit', 'map', '512MiB', '-limit', 'area', '128MP', '-limit', 'disk', '1GiB', '-limit', 'time', '30']
/** A shell's code for a program it could not find. */
const NOT_FOUND = 127

export type Format = 'bmp' | 'png'
/** The longer side a picture is written at, in pixels: stretched or shrunk to it, or only shrunk. */
export type Side = { pixels: number; isShrinkOnly: boolean }

type Run = { exitCode: number; stderr: string }
/** What a program that failed said: its first line on stderr less its own name, or its exit code. */
export const saidBy = (name: string, result: Run) =>
  result.stderr.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.replace(new RegExp(`^${name}: `), '').slice(0, 200) || `exit code ${result.exitCode}`

/** How `name` is run to write `file` as `format` to `out` in the folder `dir`. */
async function commandOf ($: Engine, name: Tool, system: System, file: string, dir: string, out: string, format: Format, side?: Side) {
  const path = `${dir}${system === 'windows' ? '\\' : '/'}${out}`
  if (name === 'sips') {
    // sips has no "only shrink": `-Z` also stretches a small picture, which a card does not mind.
    return { argv: ['sips', '-s', 'format', format, ...(side ? ['-Z', String(side.pixels)] : []), file, '--out', path] }
  }
  // ImageMagick's geometry, which the PowerShell reader takes too: `n>` only shrinks.
  const geometry = side && `${side.pixels}${side.isShrinkOnly ? '>' : ''}`
  if (name === 'powershell') return readerCommand(file, dir, out, format, geometry, await $.env.get('WSLENV'))
  return { argv: [name, ...LIMITS, file, ...(side ? ['-resize', `${side.pixels}x${geometry}`] : []), `${format === 'bmp' ? 'BMP3' : 'PNG'}:${path}`] }
}

// The program that read a picture first in this session: the rest are not tried again.
let tool: Tool | undefined

/** Tries every program again: a session starts. */
export function forgetReaders () {
  tool = undefined
}

/**
 * Writes `file` as `format` to `out` in the folder `dir`, with the first program that manages it, at
 * `side` (without it, as it is). True once one has; otherwise the first program that ran and failed,
 * with what it said, or undefined when none could be run.
 */
export async function write ($: Engine, system: System, file: string, dir: string, out: string, format: Format, side?: Side) {
  let refused: { name: Tool; said: string } | undefined
  for (const name of tool ? [tool] : TOOLS[system]) {
    const { argv, env } = await commandOf($, name, system, file, dir, out, format, side) as { argv: string[]; env?: Record<string, string> }
    const result = await $.process.run(argv, env && { env }).catch(() => undefined)
    if (result?.exitCode === 0) {
      tool = name
      return true
    }
    if (result && result.exitCode !== NOT_FOUND) refused ??= { name, said: saidBy(name, result) }
  }
  return refused
}
