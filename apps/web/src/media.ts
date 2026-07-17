import {
  analyzeSequence,
  detectLoopCandidates,
  type FrameFeature,
  type LoopCandidate,
} from '@frameloop/core'
import { despillChromaPixels, parseHexColor } from './chroma'
import type { CapturedFrame, ExtractionProgress } from './types'

const FEATURE_SIZE = 24

function waitForEvent(target: EventTarget, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSuccess = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error(`媒体事件失败：${event}`))
    }
    const cleanup = () => {
      target.removeEventListener(event, onSuccess)
      target.removeEventListener('error', onError)
    }
    target.addEventListener(event, onSuccess, { once: true })
    target.addEventListener('error', onError, { once: true })
  })
}

async function seek(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 0.0005 && video.readyState >= 2) return
  video.currentTime = time
  await waitForEvent(video, 'seeked')
}

function extractFeature(canvas: HTMLCanvasElement, index: number, timestamp: number): FrameFeature {
  const sample = canvas.width === FEATURE_SIZE && canvas.height === FEATURE_SIZE
    ? canvas
    : document.createElement('canvas')
  if (sample !== canvas) {
    sample.width = FEATURE_SIZE
    sample.height = FEATURE_SIZE
    sample.getContext('2d', { willReadFrequently: true })!.drawImage(canvas, 0, 0, FEATURE_SIZE, FEATURE_SIZE)
  }
  const context = sample.getContext('2d', { willReadFrequently: true })!
  const pixels = context.getImageData(0, 0, FEATURE_SIZE, FEATURE_SIZE).data
  const luma = new Array<number>(FEATURE_SIZE * FEATURE_SIZE)
  let weightedX = 0
  let weightedY = 0
  let weight = 0

  for (let y = 0; y < FEATURE_SIZE; y += 1) {
    for (let x = 0; x < FEATURE_SIZE; x += 1) {
      const offset = (y * FEATURE_SIZE + x) * 4
      const alpha = (pixels[offset + 3] ?? 255) / 255
      const value = ((pixels[offset] ?? 0) * 0.2126
        + (pixels[offset + 1] ?? 0) * 0.7152
        + (pixels[offset + 2] ?? 0) * 0.0722) / 255
      luma[y * FEATURE_SIZE + x] = value
      const foregroundWeight = Math.abs(value - luma[0]!) * alpha
      weightedX += x * foregroundWeight
      weightedY += y * foregroundWeight
      weight += foregroundWeight
    }
  }

  const edges = new Array<number>(luma.length).fill(0)
  for (let y = 1; y < FEATURE_SIZE - 1; y += 1) {
    for (let x = 1; x < FEATURE_SIZE - 1; x += 1) {
      const at = (dx: number, dy: number) => luma[(y + dy) * FEATURE_SIZE + x + dx] ?? 0
      const gx = -at(-1, -1) + at(1, -1) - 2 * at(-1, 0) + 2 * at(1, 0) - at(-1, 1) + at(1, 1)
      const gy = -at(-1, -1) - 2 * at(0, -1) - at(1, -1) + at(-1, 1) + 2 * at(0, 1) + at(1, 1)
      edges[y * FEATURE_SIZE + x] = Math.min(1, Math.hypot(gx, gy) / 4)
    }
  }

  return {
    index,
    timestamp,
    luma,
    edges,
    centroid: weight > 1e-6
      ? { x: weightedX / weight / (FEATURE_SIZE - 1), y: weightedY / weight / (FEATURE_SIZE - 1) }
      : { x: 0.5, y: 0.5 },
    coverage: Math.min(1, weight / luma.length),
  }
}

export interface BrowserVideoScan {
  duration: number
  sampledFrames: number
  windowsAnalyzed: number
  peakBufferedFrames: number
  candidates: LoopCandidate[]
  selectedCandidate: LoopCandidate | null
}

export interface BrowserVideoCaptureResult {
  frames: CapturedFrame[]
  scan: BrowserVideoScan
}

function offsetCandidate(candidate: LoopCandidate, offset: number): LoopCandidate {
  return {
    ...candidate,
    startFrame: candidate.startFrame + offset,
    endFrame: candidate.endFrame + offset,
  }
}

export function mergeLoopCandidates(candidates: LoopCandidate[]) {
  const result: LoopCandidate[] = []
  for (const candidate of candidates.sort((a, b) => a.score - b.score || a.frameCount - b.frameCount)) {
    const duplicate = result.some((picked) =>
      Math.abs(picked.startFrame - candidate.startFrame) <= 1
      && Math.abs(picked.endFrame - candidate.endFrame) <= 1)
    if (!duplicate) result.push(candidate)
  }
  return result
}

async function captureFrameRangeFromVideo(
  video: HTMLVideoElement,
  fps: number,
  requestedStart: number,
  requestedEnd: number,
  onProgress?: (progress: ExtractionProgress) => void,
  signal?: AbortSignal,
) {
  const totalFrames = Math.max(2, Math.ceil(video.duration * fps))
  const startFrame = Math.max(0, Math.min(totalFrames - 1, Math.floor(requestedStart)))
  const endFrame = Math.max(startFrame, Math.min(totalFrames - 1, Math.floor(requestedEnd)))
  const captureTotal = endFrame - startFrame + 1
  const frames: CapturedFrame[] = []
  for (let sourceIndex = startFrame; sourceIndex <= endFrame; sourceIndex += 1) {
    if (signal?.aborted) throw new Error('视频分析已取消')
    const timestamp = Math.min(video.duration - 0.001, sourceIndex / fps)
    await seek(video, timestamp)
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    frames.push({
      index: sourceIndex,
      timestamp,
      canvas,
      previewUrl: canvas.toDataURL('image/jpeg', 0.72),
      feature: extractFeature(canvas, sourceIndex, timestamp),
    })
    onProgress?.({ phase: 'capturing', current: frames.length, total: captureTotal })
    if (frames.length % 6 === 0) await new Promise((resolve) => window.setTimeout(resolve, 0))
  }
  return frames
}

export async function captureVideoFrameRange(
  file: File,
  fps: number,
  startFrame: number,
  endFrame: number,
  onProgress?: (progress: ExtractionProgress) => void,
  signal?: AbortSignal,
): Promise<CapturedFrame[]> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.src = url
  try {
    await waitForEvent(video, 'loadedmetadata')
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('无法读取视频时长')
    return await captureFrameRangeFromVideo(
      video,
      Math.max(0.01, fps),
      startFrame,
      endFrame,
      onProgress,
      signal,
    )
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

export async function captureVideoFrames(
  file: File,
  fps: number,
  minLoopFrames: number,
  analysisWindowSeconds: number,
  onProgress?: (progress: ExtractionProgress) => void,
  signal?: AbortSignal,
): Promise<BrowserVideoCaptureResult> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.src = url

  try {
    await waitForEvent(video, 'loadedmetadata')
    const duration = video.duration
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长')
    const safeFps = Math.max(0.01, fps)
    const total = Math.max(2, Math.ceil(duration * safeFps))
    const safeMinLoopFrames = Math.max(2, Math.floor(minLoopFrames))
    const windowFrames = Math.max(safeMinLoopFrames, Math.round(Math.max(0.1, analysisWindowSeconds) * safeFps))
    const overlapFrames = Math.min(windowFrames - 1, Math.max(safeMinLoopFrames, Math.floor(windowFrames / 4)))
    const stride = Math.max(1, windowFrames - overlapFrames)
    const sample = document.createElement('canvas')
    sample.width = FEATURE_SIZE
    sample.height = FEATURE_SIZE
    const sampleContext = sample.getContext('2d', { willReadFrequently: true })!
    let buffer: FrameFeature[] = []
    let peakBufferedFrames = 0
    let windowsAnalyzed = 0
    let lastAnalyzedEndFrame = -1
    const windowCandidates: LoopCandidate[] = []

    const analyzeWindow = (features: FrameFeature[]) => {
      if (features.length < safeMinLoopFrames) return
      const diagnostics = analyzeSequence(features, { minFrames: safeMinLoopFrames })
      const boundaries = [
        0,
        ...diagnostics.transitions.filter((transition) => transition.isSceneCut).map((transition) => transition.frame),
        features.length,
      ].filter((value, index, values) => values.indexOf(value) === index).sort((a, b) => a - b)
      for (let segmentIndex = 0; segmentIndex < boundaries.length - 1; segmentIndex += 1) {
        const segment = features.slice(boundaries[segmentIndex], boundaries[segmentIndex + 1])
        if (segment.length < safeMinLoopFrames) continue
        windowCandidates.push(...detectLoopCandidates(segment, {
          minFrames: safeMinLoopFrames,
          maxFrames: segment.length,
          topK: 5,
          motionWindow: 3,
        }).map((candidate) => offsetCandidate(candidate, segment[0]!.index)))
      }
      windowsAnalyzed += 1
      lastAnalyzedEndFrame = features.at(-1)!.index
    }

    for (let index = 0; index < total; index += 1) {
      if (signal?.aborted) throw new Error('视频分析已取消')
      const timestamp = Math.min(duration - 0.001, index / safeFps)
      await seek(video, timestamp)
      sampleContext.drawImage(video, 0, 0, FEATURE_SIZE, FEATURE_SIZE)
      buffer.push(extractFeature(sample, index, timestamp))
      peakBufferedFrames = Math.max(peakBufferedFrames, buffer.length)
      if (buffer.length >= windowFrames) {
        analyzeWindow(buffer)
        buffer = buffer.slice(stride)
      }
      onProgress?.({ phase: 'scanning', current: index + 1, total })
      if (index % 6 === 0) await new Promise((resolve) => window.setTimeout(resolve, 0))
    }
    if (buffer.length >= safeMinLoopFrames && buffer.at(-1)!.index !== lastAnalyzedEndFrame) analyzeWindow(buffer)

    const candidates = mergeLoopCandidates(windowCandidates)
    const selectedCandidate = candidates[0] ?? null
    const captureStart = selectedCandidate?.startFrame ?? 0
    const captureEnd = selectedCandidate?.endFrame ?? Math.min(total - 1, safeMinLoopFrames - 1)
    const frames = await captureFrameRangeFromVideo(
      video, safeFps, captureStart, captureEnd, onProgress, signal,
    )
    return {
      frames,
      scan: { duration, sampledFrames: total, windowsAnalyzed, peakBufferedFrames, candidates, selectedCandidate },
    }
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

export function createDemoFrames(fps = 12, period = 8, cycles = 3): CapturedFrame[] {
  const count = period * cycles + 1
  return Array.from({ length: count }, (_, index) => {
    const phase = (index % period) / period * Math.PI * 2
    const canvas = document.createElement('canvas')
    canvas.width = 192
    canvas.height = 128
    const context = canvas.getContext('2d')!
    context.imageSmoothingEnabled = false
    context.fillStyle = '#00ff00'
    context.fillRect(0, 0, canvas.width, canvas.height)

    const x = 96 + Math.sin(phase) * 34
    const y = 70 + Math.cos(phase * 2) * 6
    const squash = 1 - Math.max(0, Math.cos(phase)) * 0.08
    context.save()
    context.translate(Math.round(x), Math.round(y))
    context.scale(1, squash)
    context.fillStyle = '#1b2116'
    context.fillRect(-18, 21, 36, 5)
    context.fillStyle = '#ff7652'
    context.fillRect(-12, -13, 24, 28)
    context.fillStyle = '#ffd08a'
    context.fillRect(-9, -23, 18, 12)
    context.fillStyle = '#151812'
    context.fillRect(-5, -19, 3, 3)
    context.fillRect(4, -19, 3, 3)
    context.fillStyle = '#c7f36a'
    const armSwing = Math.round(Math.sin(phase) * 7)
    context.fillRect(-18, -8 + armSwing, 6, 17)
    context.fillRect(12, -8 - armSwing, 6, 17)
    context.fillStyle = '#27301f'
    context.fillRect(-11, 15, 8, 12 + Math.max(0, -armSwing))
    context.fillRect(3, 15, 8, 12 + Math.max(0, armSwing))
    context.restore()

    const timestamp = index / fps
    return {
      index,
      timestamp,
      canvas,
      previewUrl: canvas.toDataURL('image/png'),
      feature: extractFeature(canvas, index, timestamp),
    }
  })
}

export function applyChromaKey(
  source: HTMLCanvasElement,
  keyColor: string,
  tolerance: number,
  feather: number,
): HTMLCanvasElement {
  return renderWithAlpha(source, calculateChromaAlpha(source, keyColor, tolerance, feather), keyColor)
}

function calculateChromaAlpha(
  source: HTMLCanvasElement,
  keyColor: string,
  tolerance: number,
  feather: number,
): Uint8ClampedArray {
  const context = source.getContext('2d', { willReadFrequently: true })!
  const image = context.getImageData(0, 0, source.width, source.height)
  const key = keyColor.match(/[a-f\d]{2}/gi)?.map((value) => Number.parseInt(value, 16)) ?? [0, 255, 0]
  const hard = Math.max(0, tolerance)
  const soft = Math.max(1, feather)
  const alpha = new Uint8ClampedArray(source.width * source.height)

  for (let offset = 0; offset < image.data.length; offset += 4) {
    const distance = Math.hypot(
      (image.data[offset] ?? 0) - (key[0] ?? 0),
      (image.data[offset + 1] ?? 0) - (key[1] ?? 255),
      (image.data[offset + 2] ?? 0) - (key[2] ?? 0),
    )
    const keyAlpha = distance <= hard ? 0 : Math.min(1, (distance - hard) / soft)
    alpha[offset / 4] = Math.round((image.data[offset + 3] ?? 255) * keyAlpha)
  }
  return alpha
}

function renderWithAlpha(
  source: HTMLCanvasElement,
  alpha: Uint8ClampedArray,
  keyColor?: string,
): HTMLCanvasElement {
  const target = document.createElement('canvas')
  target.width = source.width
  target.height = source.height
  const context = target.getContext('2d', { willReadFrequently: true })!
  context.drawImage(source, 0, 0)
  const image = context.getImageData(0, 0, target.width, target.height)
  const output = keyColor
    ? despillChromaPixels(image.data, alpha, target.width, target.height, parseHexColor(keyColor))
    : image.data
  if (!keyColor) {
    for (let index = 0; index < alpha.length; index += 1) output[index * 4 + 3] = alpha[index] ?? 255
  }
  image.data.set(output)
  context.putImageData(image, 0, 0)
  return target
}

export function stabilizeTemporalAlpha(
  previous: Uint8ClampedArray | undefined,
  current: Uint8ClampedArray,
  next: Uint8ClampedArray | undefined,
  consistency: number,
): Uint8ClampedArray {
  if (!previous && !next) return current
  const amount = Math.max(0, Math.min(1, consistency))
  const result = new Uint8ClampedArray(current.length)
  for (let index = 0; index < current.length; index += 1) {
    const a = previous?.[index] ?? current[index] ?? 255
    const b = current[index] ?? 255
    const c = next?.[index] ?? b
    const temporalMedian = a + b + c - Math.min(a, b, c) - Math.max(a, b, c)
    result[index] = Math.round(b * (1 - amount) + temporalMedian * amount)
  }
  return result
}

export function applyTemporalChromaKeyFrame(
  source: HTMLCanvasElement,
  previous: HTMLCanvasElement | undefined,
  next: HTMLCanvasElement | undefined,
  keyColor: string,
  tolerance: number,
  feather: number,
  consistency: number,
): HTMLCanvasElement {
  const currentAlpha = calculateChromaAlpha(source, keyColor, tolerance, feather)
  const previousAlpha = previous ? calculateChromaAlpha(previous, keyColor, tolerance, feather) : undefined
  const nextAlpha = next ? calculateChromaAlpha(next, keyColor, tolerance, feather) : undefined
  return renderWithAlpha(
    source,
    stabilizeTemporalAlpha(previousAlpha, currentAlpha, nextAlpha, consistency),
    keyColor,
  )
}

/** 使用三帧滑动窗口批量抠图，内存中最多保留三张 Alpha 蒙版。 */
export function applyTemporalChromaKey(
  sources: HTMLCanvasElement[],
  keyColor: string,
  tolerance: number,
  feather: number,
  consistency: number,
): HTMLCanvasElement[] {
  if (sources.length === 0) return []
  const result: HTMLCanvasElement[] = []
  let previousAlpha: Uint8ClampedArray | undefined
  let currentAlpha = calculateChromaAlpha(sources[0]!, keyColor, tolerance, feather)
  let nextAlpha = sources[1] ? calculateChromaAlpha(sources[1], keyColor, tolerance, feather) : undefined
  for (let index = 0; index < sources.length; index += 1) {
    result.push(renderWithAlpha(
      sources[index]!,
      stabilizeTemporalAlpha(previousAlpha, currentAlpha, nextAlpha, consistency),
      keyColor,
    ))
    previousAlpha = currentAlpha
    currentAlpha = nextAlpha ?? currentAlpha
    nextAlpha = sources[index + 2]
      ? calculateChromaAlpha(sources[index + 2]!, keyColor, tolerance, feather)
      : undefined
  }
  return result
}

export interface AlphaFlickerDiagnostics {
  raw: number
  stabilized: number
  improvement: number
  sampledFrames: number
}

function downscale(source: HTMLCanvasElement, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  canvas.getContext('2d')!.drawImage(source, 0, 0, size, size)
  return canvas
}

function meanAlphaDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let total = 0
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    total += Math.abs((a[index] ?? 0) - (b[index] ?? 0)) / 255
  }
  return total / Math.max(1, Math.min(a.length, b.length))
}

export function measureAlphaFlicker(
  sources: HTMLCanvasElement[],
  keyColor: string,
  tolerance: number,
  feather: number,
  consistency: number,
  sampleSize = 48,
): AlphaFlickerDiagnostics {
  const masks = sources.map((source) => calculateChromaAlpha(
    downscale(source, sampleSize), keyColor, tolerance, feather,
  ))
  if (masks.length < 2) return { raw: 0, stabilized: 0, improvement: 0, sampledFrames: masks.length }
  const stabilizedMasks = masks.map((mask, index) => stabilizeTemporalAlpha(
    masks[index - 1], mask, masks[index + 1], consistency,
  ))
  const rawDifferences: number[] = []
  const stabilizedDifferences: number[] = []
  for (let index = 1; index < masks.length; index += 1) {
    rawDifferences.push(meanAlphaDifference(masks[index - 1]!, masks[index]!))
    stabilizedDifferences.push(meanAlphaDifference(stabilizedMasks[index - 1]!, stabilizedMasks[index]!))
  }
  const raw = rawDifferences.reduce((sum, value) => sum + value, 0) / rawDifferences.length
  const stabilized = stabilizedDifferences.reduce((sum, value) => sum + value, 0) / stabilizedDifferences.length
  return {
    raw,
    stabilized,
    improvement: raw > 1e-6 ? Math.max(0, (raw - stabilized) / raw) : 0,
    sampledFrames: masks.length,
  }
}
