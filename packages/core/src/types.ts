export interface FrameFeature {
  index: number
  timestamp: number
  /** 归一化到 0..1 的低分辨率亮度特征。 */
  luma: number[]
  /** 归一化到 0..1 的边缘强度特征。 */
  edges: number[]
  /** 前景质心，归一化到画布宽高。 */
  centroid: { x: number; y: number }
  /** 非背景/非透明像素占比。 */
  coverage: number
}

export interface LoopAnalysisOptions {
  minFrames?: number
  maxFrames?: number
  topK?: number
  /** 评分窗口；用于比较接缝两侧的运动节奏。 */
  motionWindow?: number
  weights?: Partial<LoopScoreWeights>
}

export interface LoopScoreWeights {
  closure: number
  motion: number
  appearance: number
  periodicity: number
  staticPenalty: number
  duplicatePenalty: number
}

export interface FrameTransitionMetric {
  /** 转场终点帧，即 fromFrame + 1。 */
  frame: number
  fromFrame: number
  timestamp: number
  distance: number
  acceleration: number
  isDuplicate: boolean
  isSceneCut: boolean
}

export interface DuplicateFrameGroup {
  startFrame: number
  endFrame: number
  frameCount: number
}

export interface PeriodEstimate {
  periodFrames: number
  mismatch: number
  confidence: number
  support: number
}

export interface SequenceDiagnostics {
  transitions: FrameTransitionMetric[]
  duplicateGroups: DuplicateFrameGroup[]
  dominantPeriods: PeriodEstimate[]
  duplicateThreshold: number
  sceneCutThreshold: number
}

export interface LoopCandidate {
  startFrame: number
  endFrame: number
  frameCount: number
  startTime: number
  endTime: number
  score: number
  confidence: number
  suggestsDropLastFrame: boolean
  diagnostics: {
    closure: number
    motionMismatch: number
    appearanceMismatch: number
    periodicityMismatch: number
    staticPenalty: number
    duplicatePenalty: number
    meanMotion: number
    seamMotion: number
    expectedMotion: number
    periodSupport: number
  }
}

export interface SpriteLayoutOptions {
  frameWidth: number
  frameHeight: number
  frameCount: number
  columns?: number
  padding?: number
}

export interface SpriteLayout {
  columns: number
  rows: number
  width: number
  height: number
  frames: Array<{
    index: number
    x: number
    y: number
    w: number
    h: number
  }>
}

export interface TightSpriteFrameSize {
  w: number
  h: number
}

export interface TightSpriteLayoutOptions {
  frames: TightSpriteFrameSize[]
  columns?: number
  padding?: number
}

export interface TightSpriteLayout {
  columns: number
  rows: number
  width: number
  height: number
  frames: Array<{
    index: number
    x: number
    y: number
    w: number
    h: number
  }>
}
