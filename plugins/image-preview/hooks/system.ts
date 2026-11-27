// The system a session runs on, and showing a path with that system's own programs. Each plugin
// installs as a folder of its own, so both carry this file; `cargo test -p checks` keeps the two
// copies the same.
import type { EngineInterface } from 'claude-code'

type Engine = EngineInterface

export type System = 'linux' | 'macos' | 'windows' | 'wsl'

let known: Promise<System> | undefined

/**
 * The system, learned once until `forgetSystem`: from `OS`, the distro's name and `uname`. Claude
 * Code 2.1.325 has no `$.session.info()`, and a module that calls it does not load there at all.
 */
export function systemOf ($: Engine) {
  return (known ??= (async (): Promise<System> => {
    const [os, distro] = await Promise.all([$.env.get('OS'), $.env.get('WSL_DISTRO_NAME')])
    if (os === 'Windows_NT') return 'windows'
    if (distro !== undefined) return 'wsl'
    return (await $.process.run(['uname', '-s']).catch(() => undefined))?.stdout.trim() === 'Darwin' ? 'macos' : 'linux'
  })())
}

/** Makes the next `systemOf` learn the system again: a session starts. */
export function forgetSystem () {
  known = undefined
}

/**
 * Opens `path` in the system's own program for it, or with `isSelecting` shows it selected in the
 * file manager: Explorer on Windows and under WSL, Finder on macOS, and on Linux the manager that
 * answers FileManager1 (Nautilus) or, where none does, the path's folder opened. A program that
 * fails or is missing is left at that.
 */
export async function show ($: Engine, path: string, isSelecting: boolean) {
  const run = (argv: string[]) => $.process.run(argv).catch(() => undefined)
  const system = await systemOf($)
  if (system === 'windows' || system === 'wsl') {
    const shown = system === 'wsl' ? (await run(['wslpath', '-w', path]))?.stdout.trim() : path
    // Explorer takes the path as an argument of its own after `/select,`: quoted in one with it,
    // it opens the Documents folder instead.
    if (shown) await run(isSelecting ? ['explorer.exe', '/select,', shown] : ['explorer.exe', shown])
    return
  }
  if (system === 'macos') {
    await run(isSelecting ? ['open', '-R', path] : ['open', path])
    return
  }
  if (!isSelecting) {
    await run(['xdg-open', path])
    return
  }
  const uri = `file://${path.split('/').map(encodeURIComponent).join('/')}`
  const shown = await run(['dbus-send', '--session', '--print-reply', '--dest=org.freedesktop.FileManager1', '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1.ShowItems', `array:string:${uri}`, 'string:'])
  if (shown?.exitCode !== 0) await run(['xdg-open', path.slice(0, path.lastIndexOf('/')) || '/'])
}
