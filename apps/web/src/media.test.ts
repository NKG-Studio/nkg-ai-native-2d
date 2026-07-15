import { describe, expect, it } from 'vitest'
import { stabilizeTemporalAlpha } from './media'

describe('stabilizeTemporalAlpha', () => {
  it('uses the temporal median to suppress a one-frame alpha spike', () => {
    const previous = new Uint8ClampedArray([0, 255])
    const current = new Uint8ClampedArray([255, 255])
    const next = new Uint8ClampedArray([0, 255])
    expect(Array.from(stabilizeTemporalAlpha(previous, current, next, 1))).toEqual([0, 255])
  })

  it('keeps the current mask when temporal consistency is disabled', () => {
    const current = new Uint8ClampedArray([42, 128])
    const result = stabilizeTemporalAlpha(new Uint8ClampedArray([0, 0]), current, new Uint8ClampedArray([255, 255]), 0)
    expect(Array.from(result)).toEqual([42, 128])
  })
})
