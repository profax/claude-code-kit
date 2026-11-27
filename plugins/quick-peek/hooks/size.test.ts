import { expect, test } from 'claude-code/testing'

import { sizeOf } from './size'

test('a size is written in the largest unit it fills', () => {
  expect(sizeOf(0)).toBe('0 B')
  expect(sizeOf(1023)).toBe('1023 B')
  expect(sizeOf(1024)).toBe('1 KB')
  expect(sizeOf(300 * 1024)).toBe('300 KB')
  expect(sizeOf(12.5 * 1024 ** 2)).toBe('12.5 MB')
  expect(sizeOf(3 * 1024 ** 3)).toBe('3.0 GB')
})
