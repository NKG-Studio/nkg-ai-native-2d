import { describe, expect, it } from 'vitest'
import { analyzeSpriteSheet, convexHull, minimumAreaRectangle } from './sprite-detection'

const rgba = (width: number, height: number, pixels: Array<[number, number, number?, number?, number?]>) => {
  const data = new Uint8ClampedArray(width * height * 4)
  for (const [x, y, r = 255, g = 255, b = 255] of pixels) {
    const offset = (y * width + x) * 4
    data[offset] = r
    data[offset + 1] = g
    data[offset + 2] = b
    data[offset + 3] = 255
  }
  return data
}

const rectangle = (x: number, y: number, width: number, height: number) => {
  const result: Array<[number, number]> = []
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) result.push([column, row])
  }
  return result
}

describe('sprite sheet detection', () => {
  it('finds differently sized components in an irregular atlas', () => {
    const data = rgba(20, 14, [
      ...rectangle(1, 1, 3, 4),
      ...rectangle(9, 2, 7, 2),
      ...rectangle(5, 8, 4, 5),
    ])
    const analysis = analyzeSpriteSheet(data, 20, 14)
    expect(analysis.sprites.map((sprite) => sprite.bounds)).toEqual([
      { x: 1, y: 1, w: 3, h: 4 },
      { x: 9, y: 2, w: 7, h: 2 },
      { x: 5, y: 8, w: 4, h: 5 },
    ])
    expect(analysis.recommendation.layout).toBe('components')
  })

  it('recognizes a conservative regular grid candidate', () => {
    const data = rgba(16, 16, [
      ...rectangle(1, 1, 3, 3),
      ...rectangle(10, 1, 3, 3),
      ...rectangle(1, 10, 3, 3),
      ...rectangle(10, 10, 3, 3),
    ])
    const analysis = analyzeSpriteSheet(data, 16, 16)
    expect(analysis.gridCandidate).toEqual(expect.objectContaining({ columns: 2, rows: 2, frameCount: 4 }))
    expect(analysis.recommendation.layout).toBe('grid')
  })

  it('uses the dominant edge color when the atlas is opaque', () => {
    const data = new Uint8ClampedArray(10 * 8 * 4)
    for (let index = 0; index < 10 * 8; index += 1) {
      data[index * 4] = 20
      data[index * 4 + 1] = 30
      data[index * 4 + 2] = 40
      data[index * 4 + 3] = 255
    }
    for (const [x, y] of rectangle(3, 2, 4, 3)) {
      const offset = (y * 10 + x) * 4
      data[offset] = 230
      data[offset + 1] = 120
      data[offset + 2] = 10
    }
    const analysis = analyzeSpriteSheet(data, 10, 8, { backgroundMode: 'auto', backgroundTolerance: 20 })
    expect(analysis.background.mode).toBe('edge-color')
    expect(analysis.sprites[0]?.bounds).toEqual({ x: 3, y: 2, w: 4, h: 3 })
  })

  it('recommends an oriented rectangle for a diagonal component', () => {
    const pixels: Array<[number, number]> = []
    for (let step = 0; step < 10; step += 1) {
      pixels.push([3 + step, 3 + step], [4 + step, 3 + step], [3 + step, 4 + step])
    }
    const analysis = analyzeSpriteSheet(rgba(18, 18, pixels), 18, 18)
    expect(Math.abs(analysis.sprites[0]!.orientedBounds.angleDegrees)).toBeGreaterThan(20)
    expect(analysis.sprites[0]!.rotationSavings).toBeGreaterThan(0.4)
    expect(analysis.recommendation.bounds).toBe('oriented')
  })

  it('can merge nearby disconnected parts when requested', () => {
    const data = rgba(12, 6, [...rectangle(1, 1, 2, 2), ...rectangle(5, 1, 2, 2)])
    expect(analyzeSpriteSheet(data, 12, 6).sprites).toHaveLength(2)
    expect(analyzeSpriteSheet(data, 12, 6, { mergeGap: 3 }).sprites).toHaveLength(1)
  })
})

describe('geometry helpers', () => {
  it('builds a convex hull and minimum rectangle', () => {
    const hull = convexHull([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 2, y: 1 }, { x: 0, y: 2 }])
    expect(hull).toHaveLength(4)
    expect(minimumAreaRectangle(hull)).toEqual(expect.objectContaining({ w: 4, h: 2, angleDegrees: 0 }))
  })
})
