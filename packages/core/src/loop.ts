import type {
  DuplicateFrameGroup,
  FrameFeature,
  FrameTransitionMetric,
  LoopAnalysisOptions,
  LoopCandidate,
  LoopScoreWeights,
  PeriodEstimate,
  SequenceDiagnostics,
} from './types.js'

const DEFAULT_WEIGHTS: LoopScoreWeights = {
  closure: 0.34,
  motion: 0.24,
  periodicity: 0.24,
  appearance: 0.08,
  staticPenalty: 0.06,
  duplicatePenalty: 0.04,
}

const DEFAULT_DUPLICATE_THRESHOLD = 0.012
const DEFAULT_SCENE_CUT_THRESHOLD = 0.24
const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

function rms(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  if (length === 0) return 1
  let sum = 0
  for (let i = 0; i < length; i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0)
    sum += delta * delta
  }
  return Math.sqrt(sum / length)
}

/** 两帧的感知距离。0 表示一致，1 表示差异极大。 */
export function featureDistance(a: FrameFeature, b: FrameFeature): number {
  const luma = rms(a.luma, b.luma)
  const edges = rms(a.edges, b.edges)
  const centroid = Math.hypot(
    a.centroid.x - b.centroid.x,
    a.centroid.y - b.centroid.y,
  ) / Math.SQRT2
  const coverage = Math.abs(a.coverage - b.coverage)
  return clamp01(luma * 0.5 + edges * 0.27 + centroid * 0.16 + coverage * 0.07)
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0)
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))] ?? 0
}

function adjacentDistances(features: FrameFeature[]): number[] {
  return Array.from({ length: Math.max(0, features.length - 1) }, (_, index) =>
    featureDistance(features[index]!, features[index + 1]!))
}

function prefixSums(values: number[]): number[] {
  const prefix = new Array<number>(values.length + 1).fill(0)
  for (let index = 0; index < values.length; index += 1) {
    prefix[index + 1] = (prefix[index] ?? 0) + (values[index] ?? 0)
  }
  return prefix
}

function rangeMean(prefix: number[], start: number, endExclusive: number): number {
  if (endExclusive <= start) return 0
  return ((prefix[endExclusive] ?? 0) - (prefix[start] ?? 0)) / (endExclusive - start)
}

/** 生成逐帧转场指标，可直接绘制时间线差异曲线。 */
export function analyzeFrameTransitions(
  features: FrameFeature[],
  duplicateThreshold = DEFAULT_DUPLICATE_THRESHOLD,
  sceneCutThreshold?: number,
): FrameTransitionMetric[] {
  const distances = adjacentDistances(features)
  return distances.map((distance, index) => {
    const acceleration = index === 0 ? 0 : Math.abs(distance - (distances[index - 1] ?? distance))
    const radius = 12
    const neighbors = distances
      .slice(Math.max(0, index - radius), Math.min(distances.length, index + radius + 1))
      .filter((_, localIndex) => Math.max(0, index - radius) + localIndex !== index)
    const localMedian = median(neighbors)
    const localP90 = percentile(neighbors, 0.9)
    const localThreshold = Math.max(0.018, localMedian * 2.6, localP90 * 1.35)
    const accelerationThreshold = Math.max(0.012, localMedian * 1.5)
    const isSceneCut = sceneCutThreshold === undefined
      ? distance >= localThreshold && acceleration >= accelerationThreshold
      : distance >= sceneCutThreshold
    return {
      frame: index + 1,
      fromFrame: index,
      timestamp: features[index + 1]?.timestamp ?? 0,
      distance,
      acceleration,
      isDuplicate: distance <= duplicateThreshold,
      isSceneCut,
    }
  })
}

export function detectDuplicateFrameGroups(
  features: FrameFeature[],
  duplicateThreshold = DEFAULT_DUPLICATE_THRESHOLD,
): DuplicateFrameGroup[] {
  const transitions = analyzeFrameTransitions(features, duplicateThreshold)
  const groups: DuplicateFrameGroup[] = []
  let start: number | null = null
  transitions.forEach((transition, index) => {
    if (transition.isDuplicate && start === null) start = index
    const isLast = index === transitions.length - 1
    if (start !== null && (!transition.isDuplicate || isLast)) {
      const endFrame = transition.isDuplicate && isLast ? index + 1 : index
      groups.push({ startFrame: start, endFrame, frameCount: endFrame - start + 1 })
      start = null
    }
  })
  return groups
}

function calculatePeriodEstimate(features: FrameFeature[], periodFrames: number): PeriodEstimate {
  const comparisons: number[] = []
  for (let index = 0; index + periodFrames < features.length; index += 1) {
    comparisons.push(featureDistance(features[index]!, features[index + periodFrames]!))
  }
  const mismatch = comparisons.length > 0 ? mean(comparisons) : 1
  const support = comparisons.length
  const supportFactor = clamp01(support / Math.max(2, Math.min(periodFrames, 8)))
  return {
    periodFrames,
    mismatch,
    confidence: clamp01((1 - mismatch * 3.2) * supportFactor),
    support,
  }
}

/** 通过整段序列的自相似度估计主周期。 */
export function estimateDominantPeriods(
  features: FrameFeature[],
  minFrames = 3,
  maxFrames = Math.max(3, features.length - 1),
  topK = 5,
): PeriodEstimate[] {
  const estimates: PeriodEstimate[] = []
  const upper = Math.min(maxFrames, features.length - 1)
  for (let period = Math.max(2, minFrames); period <= upper; period += 1) {
    estimates.push(calculatePeriodEstimate(features, period))
  }
  estimates.sort((a, b) => b.confidence - a.confidence || a.mismatch - b.mismatch)
  const diverse: PeriodEstimate[] = []
  for (const estimate of estimates) {
    if (!diverse.some((picked) => Math.abs(picked.periodFrames - estimate.periodFrames) <= 1)) {
      diverse.push(estimate)
    }
    if (diverse.length >= topK) break
  }
  return diverse
}

export function analyzeSequence(
  features: FrameFeature[],
  options: Pick<LoopAnalysisOptions, 'minFrames' | 'maxFrames'> = {},
): SequenceDiagnostics {
  const transitions = analyzeFrameTransitions(features)
  const sceneCutThreshold = Math.min(
    ...transitions.filter((item) => item.isSceneCut).map((item) => item.distance),
    DEFAULT_SCENE_CUT_THRESHOLD,
  )
  return {
    transitions,
    duplicateGroups: detectDuplicateFrameGroups(features),
    dominantPeriods: estimateDominantPeriods(
      features,
      options.minFrames ?? 3,
      options.maxFrames ?? Math.max(3, features.length - 1),
    ),
    duplicateThreshold: DEFAULT_DUPLICATE_THRESHOLD,
    sceneCutThreshold,
  }
}

interface ScoreContext {
  adjacent: number[]
  adjacentPrefix: number[]
  periodEstimates: Map<number, PeriodEstimate>
}

function centroidVelocity(features: FrameFeature[], from: number, to: number): { x: number; y: number } {
  const a = features[from]
  const b = features[to]
  if (!a || !b) return { x: 0, y: 0 }
  return { x: b.centroid.x - a.centroid.x, y: b.centroid.y - a.centroid.y }
}

function scoreCandidate(
  features: FrameFeature[],
  start: number,
  end: number,
  motionWindow: number,
  weights: LoopScoreWeights,
  context: ScoreContext,
): LoopCandidate {
  const closureTarget = features[end + 1] ?? features[end]!
  const closure = featureDistance(features[start]!, closureTarget)

  const headMotion = context.adjacent.slice(start, Math.min(end, start + motionWindow))
  const tailMotion = context.adjacent.slice(Math.max(start, end - motionWindow), end)
  const expectedMotion = (mean(headMotion) + mean(tailMotion)) / 2
  const seamMotion = featureDistance(features[end]!, features[start]!)
  const energyMismatch = Math.abs(seamMotion - expectedMotion)

  const headVelocity = centroidVelocity(features, start, Math.min(end, start + 1))
  const tailVelocity = centroidVelocity(features, Math.max(start, end - 1), end)
  const seamVelocity = {
    x: features[start]!.centroid.x - features[end]!.centroid.x,
    y: features[start]!.centroid.y - features[end]!.centroid.y,
  }
  const expectedVelocity = {
    x: (headVelocity.x + tailVelocity.x) / 2,
    y: (headVelocity.y + tailVelocity.y) / 2,
  }
  const directionMismatch = Math.hypot(
    seamVelocity.x - expectedVelocity.x,
    seamVelocity.y - expectedVelocity.y,
  ) / Math.SQRT2
  const motionMismatch = clamp01(energyMismatch * 3.5 * 0.6 + directionMismatch * 3 * 0.4)

  const appearanceMismatch = featureDistance(features[start]!, features[end]!)
  const frameCount = end - start + 1
  const period = context.periodEstimates.get(frameCount) ?? calculatePeriodEstimate(features, frameCount)
  const supportFactor = clamp01(period.support / Math.max(2, Math.min(frameCount, 8)))
  const periodicityMismatch = clamp01(period.mismatch * 3.2 + (1 - supportFactor) * 0.2)

  const meanMotion = rangeMean(context.adjacentPrefix, start, end)
  const globalMotionMedian = median(context.adjacent)
  const staticFloor = Math.max(0.012, globalMotionMedian * 0.35)
  const staticPenalty = clamp01((staticFloor - meanMotion) / staticFloor)

  const duplicatePenalty = clamp01((DEFAULT_DUPLICATE_THRESHOLD - appearanceMismatch) / DEFAULT_DUPLICATE_THRESHOLD)
  const suggestsDropLastFrame = duplicatePenalty > 0.5 && frameCount > 2

  const score = clamp01(
    closure * weights.closure
      + motionMismatch * weights.motion
      + periodicityMismatch * weights.periodicity
      + appearanceMismatch * weights.appearance
      + staticPenalty * weights.staticPenalty
      + duplicatePenalty * weights.duplicatePenalty,
  )

  return {
    startFrame: start,
    endFrame: end,
    frameCount,
    startTime: features[start]!.timestamp,
    endTime: features[end]!.timestamp,
    score,
    confidence: clamp01(1 - score),
    suggestsDropLastFrame,
    diagnostics: {
      closure,
      motionMismatch,
      appearanceMismatch,
      periodicityMismatch,
      staticPenalty,
      duplicatePenalty,
      meanMotion,
      seamMotion,
      expectedMotion,
      periodSupport: period.support,
    },
  }
}

/**
 * 在一段已抽样的视频帧中寻找候选循环。
 *
 * 综合全局周期自相似度、首尾闭合、运动能量/方向、静止片段与重复末帧评分。
 */
export function detectLoopCandidates(
  features: FrameFeature[],
  options: LoopAnalysisOptions = {},
): LoopCandidate[] {
  if (features.length < 3) return []

  const minFrames = Math.max(2, options.minFrames ?? 6)
  const maxFrames = Math.min(features.length, options.maxFrames ?? features.length)
  const topK = Math.max(1, options.topK ?? 5)
  const motionWindow = Math.max(1, options.motionWindow ?? 2)
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights }
  const weightSum = Object.values(weights).reduce((sum, value) => sum + value, 0) || 1
  for (const key of Object.keys(weights) as Array<keyof LoopScoreWeights>) {
    weights[key] /= weightSum
  }

  const adjacent = adjacentDistances(features)
  const estimates = Array.from({ length: Math.max(0, maxFrames - minFrames + 1) }, (_, offset) =>
    calculatePeriodEstimate(features, minFrames + offset))
  const context: ScoreContext = {
    adjacent,
    adjacentPrefix: prefixSums(adjacent),
    periodEstimates: new Map(estimates.map((estimate) => [estimate.periodFrames, estimate])),
  }

  const candidates: LoopCandidate[] = []
  for (let start = 0; start <= features.length - minFrames; start += 1) {
    const lastEnd = Math.min(features.length - 1, start + maxFrames - 1)
    for (let end = start + minFrames - 1; end <= lastEnd; end += 1) {
      candidates.push(scoreCandidate(features, start, end, motionWindow, weights, context))
    }
  }

  // 同分时优先最短完整基频，避免把两轮、三轮重复动作当成最佳循环。
  candidates.sort((a, b) => {
    const scoreDelta = a.score - b.score
    if (Math.abs(scoreDelta) > 1e-9) return scoreDelta
    return a.startFrame - b.startFrame || a.frameCount - b.frameCount
  })
  const diverse: LoopCandidate[] = []
  for (const candidate of candidates) {
    const overlapsExisting = diverse.some((picked) =>
      Math.abs(picked.startFrame - candidate.startFrame) <= 1
      && Math.abs(picked.endFrame - candidate.endFrame) <= 1)
    if (!overlapsExisting) diverse.push(candidate)
    if (diverse.length >= topK) break
  }
  return diverse
}

/**
 * Find the earliest good closure whose start is fixed to the first frame.
 * This is intended for an already segmented action: frame 0 is the action's
 * own initial pose, not necessarily an idle pose.
 */
export function detectAnchoredLoopCandidates(
  features: FrameFeature[],
  options: LoopAnalysisOptions = {},
): LoopCandidate[] {
  if (features.length < 3) return []

  const minFrames = Math.max(2, options.minFrames ?? 6)
  const maxFrames = Math.min(features.length, options.maxFrames ?? features.length)
  if (maxFrames < minFrames) return []
  const topK = Math.max(1, options.topK ?? 5)
  const motionWindow = Math.max(1, options.motionWindow ?? 2)
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights }
  const weightSum = Object.values(weights).reduce((sum, value) => sum + value, 0) || 1
  for (const key of Object.keys(weights) as Array<keyof LoopScoreWeights>) {
    weights[key] /= weightSum
  }

  const adjacent = adjacentDistances(features)
  const estimates = Array.from({ length: Math.max(0, maxFrames - minFrames + 1) }, (_, offset) =>
    calculatePeriodEstimate(features, minFrames + offset))
  const context: ScoreContext = {
    adjacent,
    adjacentPrefix: prefixSums(adjacent),
    periodEstimates: new Map(estimates.map((estimate) => [estimate.periodFrames, estimate])),
  }
  const candidates = Array.from({ length: maxFrames - minFrames + 1 }, (_, offset) =>
    scoreCandidate(features, 0, minFrames + offset - 1, motionWindow, weights, context))

  const localMinima = candidates.filter((candidate, index) =>
    candidate.score <= (candidates[index - 1]?.score ?? Number.POSITIVE_INFINITY)
    && candidate.score <= (candidates[index + 1]?.score ?? Number.POSITIVE_INFINITY))
  const pool = localMinima.length > 0 ? localMinima : candidates
  const bestScore = Math.min(...pool.map((candidate) => candidate.score))
  const acceptableScore = Math.min(0.45, bestScore + Math.max(0.025, bestScore * 0.45))
  const acceptable = pool.filter((candidate) => candidate.score <= acceptableScore)
    .sort((a, b) => a.endFrame - b.endFrame || a.score - b.score)
  const best = pool.reduce((current, candidate) => candidate.score < current.score ? candidate : current)
  if (!acceptable.some((candidate) => candidate.endFrame === best.endFrame)) acceptable.push(best)
  const tailSpan = Math.max(minFrames, motionWindow * 4)
  const tailBest = candidates.slice(Math.max(0, candidates.length - tailSpan))
    .reduce((current, candidate) => candidate.score < current.score ? candidate : current)
  if (!acceptable.some((candidate) => candidate.endFrame === tailBest.endFrame)) acceptable.push(tailBest)
  const finalBoundary = candidates.at(-1)!
  if (!acceptable.some((candidate) => candidate.endFrame === finalBoundary.endFrame)) acceptable.push(finalBoundary)
  acceptable.sort((a, b) => a.endFrame - b.endFrame || a.score - b.score)
  if (acceptable.length <= topK) return acceptable

  // The multimodal reviewer needs temporal coverage, not five near-identical
  // phase offsets at the beginning. Preserve the earliest and latest viable
  // closures, then take the best local minimum from evenly spaced middle bins.
  const selected = new Map<number, LoopCandidate>()
  selected.set(acceptable[0]!.endFrame, acceptable[0]!)
  if (topK > 1) selected.set(acceptable.at(-1)!.endFrame, acceptable.at(-1)!)
  const middleSlots = Math.max(0, topK - selected.size)
  const firstEnd = acceptable[0]!.endFrame
  const lastEnd = acceptable.at(-1)!.endFrame
  for (let slot = 0; slot < middleSlots; slot += 1) {
    const start = firstEnd + (lastEnd - firstEnd) * slot / Math.max(1, middleSlots)
    const end = firstEnd + (lastEnd - firstEnd) * (slot + 1) / Math.max(1, middleSlots)
    const inBin = acceptable.filter((candidate) =>
      candidate.endFrame > firstEnd
      && candidate.endFrame < lastEnd
      && candidate.endFrame >= start
      && (slot === middleSlots - 1 ? candidate.endFrame <= end : candidate.endFrame < end))
    if (inBin.length > 0) {
      const picked = inBin.reduce((current, candidate) => candidate.score < current.score ? candidate : current)
      selected.set(picked.endFrame, picked)
    }
  }
  for (const candidate of [...acceptable].sort((a, b) => a.score - b.score)) {
    if (selected.size >= topK) break
    selected.set(candidate.endFrame, candidate)
  }
  return [...selected.values()].sort((a, b) => a.endFrame - b.endFrame).slice(0, topK)
}
