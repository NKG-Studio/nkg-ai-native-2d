import { describe, expect, it } from 'vitest'
import { isProjectSnapshot, PROJECT_SCHEMA_VERSION, type ProjectSnapshot } from './project'

const snapshot: ProjectSnapshot = {
  schemaVersion: PROJECT_SCHEMA_VERSION,
  savedAt: '2026-07-15T12:00:00.000Z',
  source: { kind: 'demo', period: 8, repeats: 3 },
  capture: { fps: 12, analysisWindowSeconds: 20, minLoopFrames: 6 },
  editor: { order: [0, 1, 2], hidden: [], selected: [] },
  loop: { startFrame: 0, endFrame: 2 },
  matte: {
    mode: 'original', backend: null, keyColor: '#00ff00', tolerance: 72, feather: 28,
    temporalConsistency: 0.7, manualMasks: {}, automaticMattes: [],
  },
  sprite: { columns: 8, padding: 0 },
  stage: 'matte',
}

describe('project snapshot schema', () => {
  it('accepts the current schema', () => {
    expect(isProjectSnapshot(snapshot)).toBe(true)
  })

  it('accepts a legacy maxFrames capture setting for migration', () => {
    expect(isProjectSnapshot({
      ...snapshot,
      capture: { fps: 12, maxFrames: 144, minLoopFrames: 6 },
    })).toBe(true)
  })

  it('rejects unsupported versions and incomplete state', () => {
    expect(isProjectSnapshot({ ...snapshot, schemaVersion: 99 })).toBe(false)
    expect(isProjectSnapshot({ ...snapshot, editor: null })).toBe(false)
    expect(isProjectSnapshot({ ...snapshot, source: { kind: 'unknown' } })).toBe(false)
  })
})
