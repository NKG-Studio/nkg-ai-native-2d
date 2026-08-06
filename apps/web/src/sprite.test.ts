import { describe, expect, it } from 'vitest'
import { createGridSliceRegions, findOpaqueBounds } from './sprite'

const pixels = (width: number, height: number, opaque: Array<[number, number, number]>) => {
  const data = new Uint8ClampedArray(width * height * 4)
  for (const [x, y, alpha] of opaque) data[(y * width + x) * 4 + 3] = alpha
  return data
}

describe('findOpaqueBounds', () => {
  it('finds inclusive alpha bounds and honors the threshold', () => {
    const data = pixels(5, 4, [[1, 1, 10], [3, 2, 200], [4, 3, 1]])
    expect(findOpaqueBounds(data, 5, 4, 2)).toEqual({ x: 1, y: 1, w: 3, h: 2, empty: false })
  })

  it('represents fully transparent frames as a safe 1x1 slot', () => {
    expect(findOpaqueBounds(new Uint8ClampedArray(4 * 4 * 4), 4, 4, 1))
      .toEqual({ x: 0, y: 0, w: 1, h: 1, empty: true })
  })
})

describe('createGridSliceRegions', () => {
  it('creates row-major cells while excluding inter-cell padding', () => {
    expect(createGridSliceRegions(17, 8, { columns: 2, rows: 1, padding: 1 })).toEqual([
      expect.objectContaining({ frame: { x: 0, y: 0, w: 8, h: 8 } }),
      expect.objectContaining({ frame: { x: 9, y: 0, w: 8, h: 8 } }),
    ])
  })

  it('rejects dimensions that do not divide into the requested grid', () => {
    expect(() => createGridSliceRegions(16, 8, { columns: 3, rows: 1, padding: 0 }))
      .toThrow('无法按当前行列与间距整除')
  })
})
