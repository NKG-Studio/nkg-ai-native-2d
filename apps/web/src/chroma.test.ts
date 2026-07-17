import { describe, expect, it } from 'vitest'
import { despillChromaPixels, estimateSolidBackgroundColor } from './chroma'

describe('despillChromaPixels', () => {
  it('removes an opaque magenta fringe without changing the interior or alpha', () => {
    const width = 9
    const height = 9
    const pixels = new Uint8ClampedArray(width * height * 4)
    const alpha = new Uint8ClampedArray(width * height)
    for (let index = 0; index < width * height; index += 1) {
      pixels.set([255, 0, 255, 255], index * 4)
    }
    for (let y = 2; y <= 6; y += 1) {
      for (let x = 2; x <= 6; x += 1) {
        const index = y * width + x
        const edge = x === 2 || x === 6 || y === 2 || y === 6
        pixels.set(edge ? [170, 10, 180, 255] : [20, 40, 30, 255], index * 4)
        alpha[index] = 255
      }
    }

    const output = despillChromaPixels(pixels, alpha, width, height, [255, 0, 255])
    const edgeOffset = (4 * width + 2) * 4
    const centerOffset = (4 * width + 4) * 4
    const distanceToKey = (offset: number) => Math.hypot(
      (output[offset] ?? 0) - 255,
      output[offset + 1] ?? 0,
      (output[offset + 2] ?? 0) - 255,
    )
    expect(distanceToKey(edgeOffset)).toBeGreaterThan(Math.hypot(170 - 255, 10, 180 - 255))
    expect(Array.from(output.slice(centerOffset, centerOffset + 4))).toEqual([20, 40, 30, 255])
    expect(output[edgeOffset + 3]).toBe(255)
    expect(Array.from(output.slice(0, 4))).toEqual([0, 0, 0, 0])
  })

  it('recovers foreground colour for a translucent keyed edge', () => {
    const pixels = new Uint8ClampedArray([
      255, 0, 255, 255,
      20, 40, 30, 255,
      138, 20, 143, 255,
      255, 0, 255, 255,
    ])
    const alpha = new Uint8ClampedArray([0, 255, 128, 0])
    const output = despillChromaPixels(pixels, alpha, 4, 1, [255, 0, 255])
    expect(output[2 * 4 + 3]).toBe(128)
    expect(output[2 * 4 + 1]).toBeGreaterThan(20)
    expect(output[2 * 4]).toBeLessThan(138)
    expect(output[2 * 4 + 2]).toBeLessThan(143)
  })
})

describe('estimateSolidBackgroundColor', () => {
  it('detects a uniform background only from transparent matte pixels', () => {
    const pixels = new Uint8ClampedArray(40 * 4)
    const alpha = new Uint8ClampedArray(40)
    for (let index = 0; index < 40; index += 1) pixels.set([250, 4, 252, 255], index * 4)
    alpha.fill(0)
    expect(estimateSolidBackgroundColor(pixels, alpha)).toEqual([250, 4, 252])
    for (let index = 0; index < 40; index += 2) pixels.set([0, 255, 0, 255], index * 4)
    expect(estimateSolidBackgroundColor(pixels, alpha)).toBeNull()
  })
})
