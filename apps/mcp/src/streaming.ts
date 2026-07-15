import {
  analyzeSequence,
  detectAnchoredLoopCandidates,
  detectLoopCandidates,
  type DuplicateFrameGroup,
  type FrameFeature,
  type FrameTransitionMetric,
  type LoopCandidate,
  type PeriodEstimate,
} from '@frameloop/core'

export interface StreamingLoopAnalysisOptions {
  minFrames: number
  maxFrames?: number
  windowFrames: number
  overlapFrames: number
  topKPerSegment: number
  motionWindow?: number
}

export interface StreamingAnalysisWindow {
  index: number
  startFrame: number
  endFrame: number
  startTime: number
  endTime: number
  sampledFrames: number
  candidates: LoopCandidate[]
  dominantPeriods: PeriodEstimate[]
  sceneCuts: FrameTransitionMetric[]
  duplicateGroups: DuplicateFrameGroup[]
  segments: Array<{
    startFrame: number
    endFrame: number
    startTime: number
    endTime: number
    sampledFrames: number
    candidateCount: number
  }>
}

export interface StreamingLoopAnalysisResult {
  sampledFrames: number
  windowsAnalyzed: number
  peakBufferedFrames: number
  candidates: LoopCandidate[]
  windows: StreamingAnalysisWindow[]
  dominantPeriods: PeriodEstimate[]
  sceneCuts: FrameTransitionMetric[]
  duplicateGroups: DuplicateFrameGroup[]
  actionSegments: ActionLoopSegment[]
}

export interface ActionLoopSegment {
  index: number
  startFrame: number
  endFrame: number
  startTime: number
  endTime: number
  sampledFrames: number
  evidenceFrames: number
  evidenceTruncated: boolean
  candidates: ActionLoopCandidate[]
  bestScoringCandidate: ActionLoopCandidate | null
}

export interface ActionLoopCandidate extends LoopCandidate {
  source: 'segment_anchor' | 'periodic_core'
}

export interface AnchoredSegmentAnalysisOptions {
  minFrames: number
  maxFrames: number
  topKPerSegment: number
  motionWindow?: number
  evidenceCycles?: number
}

function offsetTransition(metric: FrameTransitionMetric, offset: number): FrameTransitionMetric {
  return {
    ...metric,
    frame: metric.frame + offset,
    fromFrame: metric.fromFrame + offset,
  }
}

function offsetDuplicateGroup(group: DuplicateFrameGroup, offset: number): DuplicateFrameGroup {
  return {
    ...group,
    startFrame: group.startFrame + offset,
    endFrame: group.endFrame + offset,
  }
}

function offsetCandidate(candidate: LoopCandidate, offset: number): LoopCandidate {
  return {
    ...candidate,
    startFrame: candidate.startFrame + offset,
    endFrame: candidate.endFrame + offset,
  }
}

function dedupeByFrame<T extends { frame: number; distance: number }>(items: T[]): T[] {
  const byFrame = new Map<number, T>()
  for (const item of items) {
    const previous = byFrame.get(item.frame)
    if (!previous || item.distance > previous.distance) byFrame.set(item.frame, item)
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame)
}

function dedupeDuplicateGroups(groups: DuplicateFrameGroup[]): DuplicateFrameGroup[] {
  const unique = new Map<string, DuplicateFrameGroup>()
  for (const group of groups) unique.set(`${group.startFrame}:${group.endFrame}`, group)
  return [...unique.values()].sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame)
}

function mergePeriods(windows: StreamingAnalysisWindow[], limit = 8): PeriodEstimate[] {
  const buckets = new Map<number, PeriodEstimate[]>()
  for (const window of windows) {
    for (const period of window.dominantPeriods) {
      const bucket = buckets.get(period.periodFrames) ?? []
      bucket.push(period)
      buckets.set(period.periodFrames, bucket)
    }
  }
  return [...buckets.entries()]
    .map(([periodFrames, estimates]) => ({
      periodFrames,
      mismatch: estimates.reduce((sum, item) => sum + item.mismatch, 0) / estimates.length,
      confidence: estimates.reduce((sum, item) => sum + item.confidence, 0) / estimates.length,
      support: estimates.reduce((sum, item) => sum + item.support, 0),
    }))
    .sort((a, b) => b.confidence - a.confidence || b.support - a.support || a.periodFrames - b.periodFrames)
    .slice(0, limit)
}

function mergeCandidates(windows: StreamingAnalysisWindow[], limit: number): LoopCandidate[] {
  const candidates = windows.flatMap((window) => window.candidates)
    .sort((a, b) => a.score - b.score || a.frameCount - b.frameCount)
  const diverse: LoopCandidate[] = []
  for (const candidate of candidates) {
    const duplicate = diverse.some((picked) =>
      Math.abs(picked.startFrame - candidate.startFrame) <= 1
      && Math.abs(picked.endFrame - candidate.endFrame) <= 1)
    if (!duplicate) diverse.push(candidate)
    if (diverse.length >= limit) break
  }
  return diverse
}

/**
 * Consume an arbitrarily long feature stream using a bounded, overlapping window.
 * Only one analysis window is retained; result metadata grows with window count,
 * not with decoded frame pixels.
 */
export async function analyzeFeatureStream(
  source: AsyncIterable<FrameFeature>,
  options: StreamingLoopAnalysisOptions,
): Promise<StreamingLoopAnalysisResult> {
  const minFrames = Math.max(2, Math.floor(options.minFrames))
  const windowFrames = Math.max(minFrames, Math.floor(options.windowFrames))
  const overlapFrames = Math.max(0, Math.min(windowFrames - 1, Math.floor(options.overlapFrames)))
  const stride = Math.max(1, windowFrames - overlapFrames)
  const topKPerSegment = Math.max(1, Math.floor(options.topKPerSegment))
  const windows: StreamingAnalysisWindow[] = []
  let buffer: FrameFeature[] = []
  let sampledFrames = 0
  let peakBufferedFrames = 0
  let lastAnalyzedEndFrame = -1

  const analyzeWindow = (features: FrameFeature[]) => {
    if (features.length < minFrames) return
    const offset = features[0]!.index
    const maxFrames = Math.min(options.maxFrames ?? features.length, features.length)
    const analysisOptions = {
      minFrames: Math.min(minFrames, features.length),
      maxFrames,
      topK: topKPerSegment,
      motionWindow: options.motionWindow ?? 3,
    }
    const diagnostics = analyzeSequence(features, analysisOptions)
    const cutFrames = diagnostics.transitions.filter((item) => item.isSceneCut).map((item) => item.frame)
    const boundaries = [0, ...cutFrames, features.length]
      .filter((value, index, values) => value >= 0 && value <= features.length && values.indexOf(value) === index)
      .sort((a, b) => a - b)
    const segments = boundaries.slice(0, -1).map((start, index) => features.slice(start, boundaries[index + 1]))
      .filter((segment): segment is FrameFeature[] => segment.length >= minFrames)
    const analyzedSegments = segments.map((segment) => {
      const segmentOptions = {
        ...analysisOptions,
        minFrames: Math.min(minFrames, segment.length),
        maxFrames: Math.min(maxFrames, segment.length),
      }
      const candidates = detectLoopCandidates(segment, segmentOptions)
        .map((candidate) => offsetCandidate(candidate, segment[0]!.index))
      return { segment, candidates }
    })
    const candidates = analyzedSegments.flatMap((item) => item.candidates)
    windows.push({
      index: windows.length,
      startFrame: features[0]!.index,
      endFrame: features.at(-1)!.index,
      startTime: features[0]!.timestamp,
      endTime: features.at(-1)!.timestamp,
      sampledFrames: features.length,
      candidates,
      dominantPeriods: diagnostics.dominantPeriods,
      sceneCuts: diagnostics.transitions.filter((item) => item.isSceneCut)
        .map((item) => offsetTransition(item, offset)),
      duplicateGroups: diagnostics.duplicateGroups.map((group) => offsetDuplicateGroup(group, offset)),
      segments: analyzedSegments.map(({ segment, candidates: segmentCandidates }) => ({
        startFrame: segment[0]!.index,
        endFrame: segment.at(-1)!.index,
        startTime: segment[0]!.timestamp,
        endTime: segment.at(-1)!.timestamp,
        sampledFrames: segment.length,
        candidateCount: segmentCandidates.length,
      })),
    })
    lastAnalyzedEndFrame = features.at(-1)!.index
  }

  for await (const feature of source) {
    buffer.push(feature)
    sampledFrames += 1
    peakBufferedFrames = Math.max(peakBufferedFrames, buffer.length)
    if (buffer.length < windowFrames) continue
    analyzeWindow(buffer)
    buffer = buffer.slice(stride)
  }

  if (buffer.length >= minFrames && buffer.at(-1)!.index !== lastAnalyzedEndFrame) analyzeWindow(buffer)

  return {
    sampledFrames,
    windowsAnalyzed: windows.length,
    peakBufferedFrames,
    candidates: mergeCandidates(windows, Number.POSITIVE_INFINITY),
    windows,
    dominantPeriods: mergePeriods(windows),
    sceneCuts: dedupeByFrame(windows.flatMap((window) => window.sceneCuts)),
    duplicateGroups: dedupeDuplicateGroups(windows.flatMap((window) => window.duplicateGroups)),
    actionSegments: [],
  }
}

/**
 * Re-scan the source and analyze each hard-cut action with its own first frame
 * fixed as the loop anchor. At most a small number of candidate cycles are
 * retained per action, so memory does not grow with total video duration.
 */
export async function analyzeAnchoredActionSegments(
  source: AsyncIterable<FrameFeature>,
  cutFrames: number[],
  options: AnchoredSegmentAnalysisOptions,
): Promise<ActionLoopSegment[]> {
  const minFrames = Math.max(2, Math.floor(options.minFrames))
  const maxFrames = Math.max(minFrames, Math.floor(options.maxFrames))
  const evidenceCycles = Math.max(1, options.evidenceCycles ?? 2)
  const evidenceLimit = Math.max(maxFrames + 1, maxFrames * evidenceCycles)
  const normalizedCuts: number[] = []
  for (const cut of [...new Set(cutFrames.map((value) => Math.max(0, Math.floor(value))))].sort((a, b) => a - b)) {
    if (cut === 0) continue
    const previous = normalizedCuts.at(-1) ?? 0
    if (cut - previous >= minFrames) normalizedCuts.push(cut)
  }

  const segments: ActionLoopSegment[] = []
  let nextCutIndex = 0
  let segmentStart: FrameFeature | null = null
  let segmentEnd: FrameFeature | null = null
  let sampledFrames = 0
  let evidence: FrameFeature[] = []

  const finalize = () => {
    if (!segmentStart || !segmentEnd || sampledFrames === 0) return
    const anchoredLocal = evidence.length >= minFrames
      ? detectAnchoredLoopCandidates(evidence, {
          minFrames,
          maxFrames: Math.min(maxFrames, evidence.length),
          topK: options.topKPerSegment,
          motionWindow: options.motionWindow,
        })
      : []
    const periodicRaw = evidence.length >= minFrames
      ? detectLoopCandidates(evidence, {
          minFrames,
          maxFrames: Math.min(maxFrames, evidence.length),
          topK: Math.max(options.topKPerSegment * 8, 24),
          motionWindow: options.motionWindow,
        })
      : []
    const periodGroups: Array<{ period: number; candidates: LoopCandidate[] }> = []
    for (const candidate of periodicRaw) {
      const group = periodGroups.find((item) => Math.abs(item.period - candidate.frameCount) <= 1)
      if (group) group.candidates.push(candidate)
      else periodGroups.push({ period: candidate.frameCount, candidates: [candidate] })
    }
    const periodicLocal = periodGroups.map((group) => {
      const bestScore = Math.min(...group.candidates.map((candidate) => candidate.score))
      const nearBest = group.candidates.filter((candidate) =>
        candidate.score <= bestScore + Math.max(0.015, bestScore * 0.25))
      return nearBest.reduce((earliest, candidate) =>
        candidate.startFrame < earliest.startFrame ? candidate : earliest)
    }).sort((a, b) => a.score - b.score || a.startFrame - b.startFrame)

    const candidates: ActionLoopCandidate[] = []
    const pushCandidate = (candidate: LoopCandidate | undefined, source: ActionLoopCandidate['source']) => {
      if (!candidate) return
      const global = offsetCandidate(candidate, segmentStart!.index)
      if (candidates.some((item) => item.startFrame === global.startFrame && item.endFrame === global.endFrame)) return
      candidates.push({ ...global, source })
    }
    periodicLocal.slice(0, Math.max(1, options.topKPerSegment - 2))
      .forEach((candidate) => pushCandidate(candidate, 'periodic_core'))
    pushCandidate(anchoredLocal[0], 'segment_anchor')
    pushCandidate(anchoredLocal.at(-1), 'segment_anchor')
    for (const candidate of periodicLocal) {
      if (candidates.length >= options.topKPerSegment) break
      pushCandidate(candidate, 'periodic_core')
    }
    const limitedCandidates = candidates.slice(0, options.topKPerSegment)
    const bestScoringCandidate = limitedCandidates.length > 0
      ? limitedCandidates.reduce((best, candidate) => candidate.score < best.score ? candidate : best)
      : null
    segments.push({
      index: segments.length,
      startFrame: segmentStart.index,
      endFrame: segmentEnd.index,
      startTime: segmentStart.timestamp,
      endTime: segmentEnd.timestamp,
      sampledFrames,
      evidenceFrames: evidence.length,
      evidenceTruncated: sampledFrames > evidence.length,
      candidates: limitedCandidates,
      bestScoringCandidate,
    })
  }

  for await (const feature of source) {
    const nextCut = normalizedCuts[nextCutIndex]
    if (nextCut !== undefined && feature.index >= nextCut && segmentStart) {
      finalize()
      segmentStart = null
      segmentEnd = null
      sampledFrames = 0
      evidence = []
      nextCutIndex += 1
    }
    if (!segmentStart) segmentStart = feature
    segmentEnd = feature
    sampledFrames += 1
    if (evidence.length < evidenceLimit) evidence.push(feature)
  }
  finalize()
  return segments
}
