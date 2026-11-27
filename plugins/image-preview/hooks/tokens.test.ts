import { expect, test } from 'claude-code/testing'

import { idsIn, tokensOn, wrap } from './tokens'

test('the ids of a prompt\'s tokens come each once, in the order written', () => {
  expect(idsIn('[Image #2] then [Image #1] and [Image #2] again')).toEqual([2, 1])
  expect(idsIn('no pictures')).toEqual([])
})

test('a line wraps by words, the space at a break staying at the end of its row', () => {
  expect(wrap('one two three', 8)).toEqual([{ start: 0, text: 'one two ' }, { start: 8, text: 'three' }])
  expect(wrap('', 8)).toEqual([{ start: 0, text: '' }])
})

test('a word wider than a row has no known wrap', () => {
  expect(wrap('a verylongword', 8)).toBeUndefined()
})

test('a token on a wrapped row is found by its row and column', () => {
  // 20 columns less `❯ ` wrap at 18 or 17: both put the token at the start of the second row.
  expect(tokensOn('see this picture [Image #3]', 20)).toEqual([{ id: 3, row: 1, column: 0, length: 10 }])
})

test('a token in a line after a line break is counted from the text\'s first row', () => {
  expect(tokensOn('first\n[Image #1] second', 40)).toEqual([{ id: 1, row: 1, column: 0, length: 10 }])
})

test('a prompt with a wide character gives no tokens: their columns can\'t be counted', () => {
  expect(tokensOn('图 [Image #1]', 40)).toEqual([])
})

test('when the two widths wrap differently, the count of rows drawn picks the right one', () => {
  // At 18 columns `[Image #1]` fits on the first row; at 17 the wrap splits it, and it has no place.
  const text = 'abcdefg [Image #1]'
  expect(tokensOn(text, 20)).toEqual([])
  expect(tokensOn(text, 20, 1)).toEqual([{ id: 1, row: 0, column: 8, length: 10 }])
  expect(tokensOn(text, 20, 2)).toEqual([])
})

test('a token after a double space has no place: the engine may collapse it', () => {
  expect(tokensOn('two  spaces [Image #1]', 40)).toEqual([])
})
