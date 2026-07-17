import { describe, expect, it } from 'vitest'
import type { LoopCandidate } from '@frameloop/core'
import { createLoopScanWindowConfig, mergeLoopCandidates, stabilizeTemporalAlpha } from './media'

describe('createLoopScanWindowConfig', () => {
  it('turns the longest loop into a fully overlapping internal scan window', () => {
    expect(createLoopScanWindowConfig(12, 8, 20)).toEqual({
      safeFps: 12,
      minLoopFrames: 8,
      maxLoopFrames: 240,
      windowFrames: 480,
      overlapFrames: 240,
      stride: 240,
    })
  })

  it('never allows the longest loop to be shorter than the minimum loop', () => {
    expect(createLoopScanWindowConfig(12, 24, 0.5).maxLoopFrames).toBe(24)
  })
})

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

describe('mergeLoopCandidates', () => {
  const candidate = (startFrame: number, endFrame: number, score: number) => ({
    startFrame,
    endFrame,
    frameCount: endFrame - startFrame + 1,
    score,
  }) as LoopCandidate

  it('keeps distinct loops across the full source while removing only near duplicates', () => {
    const loops = mergeLoopCandidates([
      candidate(100, 111, 0.2),
      candidate(10, 21, 0.1),
      candidate(11, 22, 0.15),
      candidate(300, 315, 0.18),
    ])
    expect(loops.map((loop) => [loop.startFrame, loop.endFrame])).toEqual([
      [10, 21],
      [300, 315],
      [100, 111],
    ])
  })
})
