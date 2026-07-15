import { describe, expect, it } from 'vitest'
import type { FrameFeature } from '@frameloop/core'
import { analyzeAnchoredActionSegments, analyzeFeatureStream } from './streaming.js'

function feature(index: number, period = 8): FrameFeature {
  const phase = (index % period) / period
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

async function* featureStream(count: number) {
  for (let index = 0; index < count; index += 1) yield feature(index)
}

describe('analyzeFeatureStream', () => {
  it('scans a long stream without buffering the full input', async () => {
    const result = await analyzeFeatureStream(featureStream(5_000), {
      minFrames: 7,
      maxFrames: 9,
      windowFrames: 64,
      overlapFrames: 16,
      topKPerSegment: 2,
    })

    expect(result.sampledFrames).toBe(5_000)
    expect(result.windowsAnalyzed).toBeGreaterThan(100)
    expect(result.peakBufferedFrames).toBe(64)
    expect(result.windows.at(-1)?.endFrame).toBe(4_999)
    expect(result.windows.at(-1)?.candidates.some((candidate) => candidate.startFrame > 4_000)).toBe(true)
    expect(result.candidates.every((candidate) => candidate.frameCount >= 7 && candidate.frameCount <= 9)).toBe(true)
  })

  it('keeps global frame numbers when windows overlap', async () => {
    const result = await analyzeFeatureStream(featureStream(180), {
      minFrames: 7,
      maxFrames: 9,
      windowFrames: 48,
      overlapFrames: 16,
      topKPerSegment: 3,
    })

    expect(result.windows.map((window) => window.startFrame)).toEqual([0, 32, 64, 96, 128, 160])
    expect(result.windows.at(-1)).toMatchObject({ startFrame: 160, endFrame: 179 })
    expect(result.windows.slice(1).every((window) =>
      window.candidates.every((candidate) => candidate.startFrame >= window.startFrame))).toBe(true)
  })
})

describe('analyzeAnchoredActionSegments', () => {
  it('anchors candidates to each hard-cut action start', async () => {
    async function* actions() {
      for (let index = 0; index < 48; index += 1) {
        if (index < 24) yield feature(index, 8)
        else {
          const local = index - 24
          const item = feature(local, 6)
          yield { ...item, index, timestamp: index / 12 }
        }
      }
    }
    const segments = await analyzeAnchoredActionSegments(actions(), [24], {
      minFrames: 5,
      maxFrames: 12,
      topKPerSegment: 3,
    })
    expect(segments).toHaveLength(2)
    expect(segments.map((segment) => [segment.startFrame, segment.endFrame])).toEqual([[0, 23], [24, 47]])
    expect(segments[0]?.candidates.some((candidate) =>
      candidate.source === 'periodic_core' && candidate.startFrame === 0 && candidate.frameCount === 8)).toBe(true)
    expect(segments[1]?.candidates.some((candidate) =>
      candidate.source === 'periodic_core' && candidate.startFrame === 24 && candidate.frameCount === 6)).toBe(true)
  })
})
