// Where the `[Image #N]` tokens of a prompt stand once the engine has wrapped it.

const TOKEN = /\[Image #(\d+)\]/g
// Under a sent prompt its first line follows `❯ `.
export const PROMPT_AT = 2

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
