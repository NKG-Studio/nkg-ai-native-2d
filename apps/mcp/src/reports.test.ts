import { describe, expect, it } from 'vitest'
import { pageAnalysisReport, type StoredAnalysisReport } from './reports.js'

const report: StoredAnalysisReport = {
  version: 3,
  id: '00000000-0000-4000-8000-000000000000',
  createdAt: '2026-07-15T00:00:00.000Z',
  videoPath: 'video.mp4',
  sourceKind: 'video',
  fps: 12,
  analysis: {
    sampledFrames: 10_000,
    windowsAnalyzed: 3,
    peakBufferedFrames: 64,
    candidates: Array.from({ length: 7 }, (_, index) => ({
      startFrame: index * 10,
      endFrame: index * 10 + 7,
      frameCount: 8,
      startTime: index,
      endTime: index + 0.58,
      score: 0.1,
      confidence: 0.9,
      suggestsDropLastFrame: false,
      diagnostics: {
        closure: 0.1,
        motionMismatch: 0.1,
        appearanceMismatch: 0.1,
        periodicityMismatch: 0.1,
        staticPenalty: 0,
        duplicatePenalty: 0,
        meanMotion: 0.2,
        seamMotion: 0.2,
        expectedMotion: 0.2,
        periodSupport: 4,
      },
    })),
    windows: Array.from({ length: 3 }, (_, index) => ({
      index,
      startFrame: index * 64,
      endFrame: index * 64 + 63,
      startTime: index * 5,
      endTime: index * 5 + 4.9,
      sampledFrames: 64,
      candidates: [],
      dominantPeriods: [],
      sceneCuts: [],
      duplicateGroups: [],
      segments: [],
    })),
    dominantPeriods: [],
    sceneCuts: [],
    duplicateGroups: [],
    actionSegments: [{
      index: 0,
      startFrame: 0,
      endFrame: 99,
      startTime: 0,
      endTime: 8.25,
      sampledFrames: 100,
      evidenceFrames: 100,
      evidenceTruncated: false,
      candidates: [],
      bestScoringCandidate: null,
    }],
  },
}

describe('pageAnalysisReport', () => {
  it('pages windows and candidates independently without truncating the stored report', () => {
    const page = pageAnalysisReport(report, {
      windowOffset: 1,
      windowLimit: 1,
      candidateOffset: 2,
      candidateLimit: 3,
    })
    expect(page.totals).toMatchObject({ sampledFrames: 10_000, windows: 3, candidates: 7, actions: 1 })
    expect(page.windowPage.items.map((item) => item.index)).toEqual([1])
    expect(page.windowPage.hasMore).toBe(true)
    expect(page.candidatePage.items.map((item) => item.startFrame)).toEqual([20, 30, 40])
    expect(page.candidatePage.hasMore).toBe(true)
    expect(page.actionPage.items.map((item) => item.index)).toEqual([0])
  })
})
