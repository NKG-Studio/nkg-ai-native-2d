import { describe, expect, it } from 'vitest'
import {
  analyzeFrameTransitions,
  createSpriteLayout,
  createTightSpriteLayout,
  detectDuplicateFrameGroups,
  detectLoopCandidates,
  estimateDominantPeriods,
  type FrameFeature,
} from './index.js'

function feature(index: number, phase: number): FrameFeature {
  const value = (Math.sin(phase * Math.PI * 2) + 1) / 2
  return {
    index,
    timestamp: index / 12,
    luma: [value, value * 0.8, 1 - value],
    edges: [Math.abs(Math.cos(phase * Math.PI * 2)), value],
    centroid: { x: 0.5 + Math.sin(phase * Math.PI * 2) * 0.2, y: 0.5 },
    coverage: 0.35,
  }
}

describe('detectLoopCandidates', () => {
  it('finds a repeated period near the expected range', () => {
    const period = 8
    const frames = Array.from({ length: 17 }, (_, index) => feature(index, (index % period) / period))
    const [best] = detectLoopCandidates(frames, { minFrames: 7, maxFrames: 9, topK: 3 })
    expect(best).toBeDefined()
    expect(best!.frameCount).toBe(period)
    expect(best!.confidence).toBeGreaterThan(0.6)
  })

  it('estimates the dominant period from repeated phases', () => {
    const period = 8
    const frames = Array.from({ length: 25 }, (_, index) => feature(index, (index % period) / period))
    const estimates = estimateDominantPeriods(frames, 5, 12, 3)
    expect(estimates.some((item) => item.periodFrames === period)).toBe(true)
    expect(estimates.find((item) => item.periodFrames === period)?.confidence).toBeGreaterThan(0.8)
  })

  it('marks repeated adjacent frames and groups them', () => {
    const frames = [feature(0, 0), feature(1, 0.25), feature(2, 0.25), feature(3, 0.25), feature(4, 0.5)]
    const transitions = analyzeFrameTransitions(frames)
    expect(transitions.filter((item) => item.isDuplicate)).toHaveLength(2)
    expect(detectDuplicateFrameGroups(frames)).toEqual([
      { startFrame: 1, endFrame: 3, frameCount: 3 },
    ])
  })

  it('recommends dropping an explicitly duplicated endpoint', () => {
    const frames = Array.from({ length: 9 }, (_, index) => feature(index, (index % 8) / 8))
    const candidate = detectLoopCandidates(frames, { minFrames: 9, maxFrames: 9, topK: 1 })[0]
    expect(candidate?.suggestsDropLastFrame).toBe(true)
    expect(candidate?.diagnostics.duplicatePenalty).toBeGreaterThan(0.5)
  })
})

describe('createSpriteLayout', () => {
  it('places frames with padding', () => {
    const layout = createSpriteLayout({ frameWidth: 32, frameHeight: 24, frameCount: 5, columns: 3, padding: 2 })
    expect(layout).toMatchObject({ columns: 3, rows: 2, width: 100, height: 50 })
    expect(layout.frames[4]).toMatchObject({ x: 34, y: 26 })
  })
})

describe('createTightSpriteLayout', () => {
  it('packs variable frame sizes into deterministic shelf rows', () => {
    const layout = createTightSpriteLayout({
      frames: [{ w: 10, h: 20 }, { w: 30, h: 8 }, { w: 12, h: 14 }],
      columns: 2,
      padding: 2,
    })
    expect(layout).toMatchObject({ columns: 2, rows: 2, width: 42, height: 36 })
    expect(layout.frames).toEqual([
      { index: 0, x: 0, y: 0, w: 10, h: 20 },
      { index: 1, x: 12, y: 0, w: 30, h: 8 },
      { index: 2, x: 0, y: 22, w: 12, h: 14 },
    ])
  })
})
