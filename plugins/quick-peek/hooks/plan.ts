// A reply read for its paths: which lead somewhere, and how the plugin draws the reply with them
// as links.
import type { EngineInterface, FsStat } from 'claude-code'

import { excerptOf, isText } from './code'
import type { Excerpt } from './code'
import { blocks, inline, items, markerOf } from './markdown'
import type { Item, Run } from './markdown'
import { lineOf, pathOfSpan, pathsIn, resolve } from './paths'
import { printable } from './printable'

type Engine = EngineInterface

/** A path in a reply that leads somewhere: where, what is there, the line it names, the card's lines. */
export type Target = { path: string; stat: FsStat; line?: number; code?: Excerpt }
export type DrawnItem = { marker: string; runs: Run[]; children: DrawnItem[]; gap: number }
/** A part of a reply: drawn by the engine's Markdown, or by the plugin with its paths as links. */
export type Part =
  | { kind: 'markdown'; text: string; gap: number }
  | { kind: 'paragraph'; runs: Run[]; gap: number }
  | { kind: 'list'; items: DrawnItem[]; gap: number }
/** How the plugin draws a reply: its parts, and the paths `Run.link` points into. */
export type Plan = { parts: Part[]; targets: Target[] }

// How long to trust that a path exists or does not, and a reply's plan: a reply is drawn often.
const FOUND_MS = 30_000
const MISSING_MS = 3_000
const PLAN_MS = 10_000
// How many plans and excerpts are kept.
const KEPT = 300
const CODE_BYTES = 1024 * 1024
// The most of a file's lines a card shows.
const CARD_LINES = 8

const stats = new Map<string, { stat: FsStat | null; at: number }>()
const plans = new Map<string, { plan: Plan | null; at: number }>()
const excerpts = new Map<string, Excerpt | null>()

/** Forgets every path, excerpt and plan: a session starts, maybe in another folder. */
export function forgetPlans () {
  plans.clear()
  stats.clear()
  excerpts.clear()
}

/** What is at `path`, a file or a folder; null for nothing or anything else. */
export async function statOf ($: Engine, path: string) {
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
  if (excerpts.size >= KEPT) excerpts.delete(excerpts.keys().next().value!)
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
export async function planOf ($: Engine, reply: string): Promise<Plan | null> {
  const text = printable(reply)
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
  const hasLink = (runs: Run[]) => runs.some(run => run.link !== undefined)
  const finishItems = (list: DraftItem[]): DrawnItem[] => list.map(item => ({ marker: item.marker, runs: finish(item.runs), children: finishItems(item.children), gap: item.gap }))
  const anyLinked = (list: DrawnItem[]): boolean => list.some(item => hasLink(item.runs) || anyLinked(item.children))

  const parts: Part[] = []
  drafted.forEach((draft, i) => {
    let part: Part = { kind: 'markdown', text: cut[i]!.text, gap: draft.gap }
    if (draft.kind === 'paragraph') {
      const runs = finish(draft.runs)
      if (hasLink(runs)) part = { kind: 'paragraph', runs, gap: draft.gap }
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
  if (plans.size >= KEPT) plans.delete(plans.keys().next().value!)
  plans.set(key, { plan, at: Date.now() })
  return plan
}
