import { expect, test } from 'claude-code/testing'

import { bmp } from './bmp.testing'
import { fit, parseBmp, toCells } from './pixels'

const RED = 0xff0000
const BLUE = 0x0000ff

test('reads a BMP bottom-up into RGBA, top row first', () => {
  const { width, height, data } = parseBmp(bmp([[RED, BLUE], [BLUE, RED]]))
  expect([width, height]).toEqual([2, 2])
  expect([...data.slice(0, 8)]).toEqual([255, 0, 0, 255, 0, 0, 255, 255])
  expect([...data.slice(8, 16)]).toEqual([0, 0, 255, 255, 255, 0, 0, 255])
})

test('fits a picture in the bounds, keeping its shape', () => {
  expect(fit(1280, 800, 64, 18)).toEqual({ columns: 58, rows: 18 })
  expect(fit(1600, 400, 64, 18)).toEqual({ columns: 64, rows: 8 })
  expect(fit(10, 10, 64, 18)).toEqual({ columns: 10, rows: 5 })
})


const wordsOf = (cells: string) => [...new Uint32Array(Uint8Array.fromBase64(cells).buffer)]

test('paints a cell of two colors as a half block: the top one over the bottom one', () => {
  expect(wordsOf(toCells(parseBmp(bmp([[RED], [BLUE]])), 1, 1))).toEqual([0x2580, RED, BLUE])
})

test('paints the quarters of a cell that differ in the foreground', () => {
  expect(wordsOf(toCells(parseBmp(bmp([[RED, BLUE], [RED, RED]])), 1, 1))).toEqual([0x259d, BLUE, RED])
  expect(wordsOf(toCells(parseBmp(bmp([[RED, BLUE], [BLUE, RED]])), 1, 1))).toEqual([0x259a, RED, BLUE])
})

test('paints an edge between the halves of a cell with an eighth block', () => {
  const rows = [RED, RED, RED, RED, RED, RED, BLUE, BLUE].map(color => [color])
  expect(wordsOf(toCells(parseBmp(bmp(rows)), 1, 1))).toEqual([0x2582, BLUE, RED])
  const columns = [[RED, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE]]
  expect(wordsOf(toCells(parseBmp(bmp([...columns, ...columns])), 1, 1))).toEqual([0x258f, RED, BLUE])
})

/**
 * A 32-bit top-down BMP of one row, its pixels as `0xAARRGGBB` words; with `masks` (red, green, blue,
 * alpha) it is BI_BITFIELDS, as sips writes one.
 */
function bmp32 (pixels: number[], masks?: number[]) {
  const header = masks ? 56 : 40
  const offset = 14 + header
  const bytes = new Uint8Array(offset + pixels.length * 4)
  const view = new DataView(bytes.buffer)
  bytes.set([0x42, 0x4d])
  view.setUint32(2, bytes.length, true)
  view.setUint32(10, offset, true)
  view.setUint32(14, header, true)
  view.setInt32(18, pixels.length, true)
  view.setInt32(22, -1, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 32, true)
  view.setUint32(30, masks ? 3 : 0, true)
  masks?.forEach((mask, i) => view.setUint32(54 + i * 4, mask, true))
  pixels.forEach((pixel, i) => view.setUint32(offset + i * 4, pixel, true))
  return bytes
}

test('reads a 32-bit BMP whose alpha byte is unused as opaque', () => {
  expect([...parseBmp(bmp32([0x00ff0000])).data]).toEqual([255, 0, 0, 255])
})

test('reads a 32-bit BMP with channel masks, alpha included', () => {
  const masks = [0x0000ff00, 0x00ff0000, 0xff000000, 0x000000ff]
  expect([...parseBmp(bmp32([0x00ff0080], masks)).data]).toEqual([0, 255, 0, 128])
})

test('reads a top-down BMP top row first', () => {
  const { data } = parseBmp(bmp32([0x000000ff, 0x00ff0000]))
  expect([...data]).toEqual([0, 0, 255, 255, 255, 0, 0, 255])
})

test('refuses what is not a BMP it can read, saying why', () => {
  const header = (edit: (view: DataView) => void) => {
    const bytes = bmp([[RED]])
    edit(new DataView(bytes.buffer))
    return bytes
  }
  expect(() => parseBmp(new Uint8Array(60))).toThrow('not a BMP file')
  expect(() => parseBmp(header(view => view.setInt32(18, 0, true)))).toThrow('an empty BMP')
  expect(() => parseBmp(header(view => view.setUint16(28, 8, true)))).toThrow('a 8-bit BMP')
  expect(() => parseBmp(header(view => view.setUint32(30, 1, true)))).toThrow('a compressed BMP')
  expect(() => parseBmp(bmp([[RED]]).slice(0, 55))).toThrow('a truncated BMP')
})
