// A BMP for the tests to read, built the way the readers the plugin runs write one.

/** A 24-bit bottom-up BMP, as ImageMagick writes one: `rows` top first, each pixel `0xRRGGBB`. */
export function bmp (rows: number[][]) {
  const width = rows[0]!.length
  const height = rows.length
  const stride = Math.ceil((width * 3) / 4) * 4
  const bytes = new Uint8Array(54 + stride * height)
  const view = new DataView(bytes.buffer)
  bytes.set([0x42, 0x4d])
  view.setUint32(2, bytes.length, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  view.setInt32(22, height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  rows.forEach((row, y) => row.forEach((color, x) => {
    const at = 54 + (height - 1 - y) * stride + x * 3
    bytes.set([color & 0xff, (color >> 8) & 0xff, color >> 16], at)
  }))
  return bytes
}
