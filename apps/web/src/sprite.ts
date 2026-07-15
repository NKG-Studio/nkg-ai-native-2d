import { createSpriteLayout, createTightSpriteLayout } from '@frameloop/core'

export type TrimMode = 'grid' | 'tight'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface SpriteFrameManifest {
  index: number
  sourceFrameId: number
  filename: string
  frame: Rect
  rotated: false
  trimmed: boolean
  empty: boolean
  spriteSourceSize: Rect
  sourceSize: { w: number; h: number }
  pivot: { x: number; y: number }
  duration: number
}

export interface SpriteSheetManifest {
  version: 2
  image: string
  animation: { name: string; loop: true; frameCount: number; duration: number }
  trimMode: TrimMode
  alphaThreshold: number
  frameSize: { width: number; height: number }
  sheetSize: { width: number; height: number }
  columns: number
  rows: number
  padding: number
  frames: SpriteFrameManifest[]
}

export interface SpriteSheetOptions {
  columns: number
  padding: number
  trimMode?: TrimMode
  alphaThreshold?: number
  pivot?: { x: number; y: number }
  animationName?: string
  durations?: number[]
  sourceFrameIds?: number[]
  imageName?: string
}

export interface SpriteExportResult {
  canvas: HTMLCanvasElement
  manifest: SpriteSheetManifest
}

interface TrimBounds extends Rect {
  empty: boolean
}

export function findOpaqueBounds(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  alphaThreshold = 1,
): TrimBounds {
  const threshold = Math.max(0, Math.min(255, Math.round(alphaThreshold)))
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((rgba[(y * width + x) * 4 + 3] ?? 0) < threshold) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  return maxX < minX || maxY < minY
    ? { x: 0, y: 0, w: 1, h: 1, empty: true }
    : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, empty: false }
}

function trimBounds(canvas: HTMLCanvasElement, mode: TrimMode, threshold: number): TrimBounds {
  if (mode === 'grid') return { x: 0, y: 0, w: canvas.width, h: canvas.height, empty: false }
  const image = canvas.getContext('2d', { willReadFrequently: true })!
    .getImageData(0, 0, canvas.width, canvas.height)
  return findOpaqueBounds(image.data, canvas.width, canvas.height, threshold)
}

export function composeSpriteSheet(
  frames: HTMLCanvasElement[],
  options: SpriteSheetOptions,
): SpriteExportResult {
  if (frames.length === 0) throw new Error('没有可导出的帧')
  const trimMode = options.trimMode ?? 'grid'
  const alphaThreshold = Math.max(0, Math.min(255, Math.round(options.alphaThreshold ?? 1)))
  const padding = Math.max(0, Math.round(options.padding))
  const columns = Math.max(1, Math.round(options.columns))
  const sourceWidth = Math.max(...frames.map((frame) => frame.width))
  const sourceHeight = Math.max(...frames.map((frame) => frame.height))
  const trims = frames.map((frame) => trimBounds(frame, trimMode, alphaThreshold))
  const layout = trimMode === 'tight'
    ? createTightSpriteLayout({ frames: trims, columns, padding })
    : createSpriteLayout({
      frameWidth: sourceWidth,
      frameHeight: sourceHeight,
      frameCount: frames.length,
      columns,
      padding,
    })
  const canvas = document.createElement('canvas')
  canvas.width = layout.width
  canvas.height = layout.height
  const context = canvas.getContext('2d')!
  context.clearRect(0, 0, canvas.width, canvas.height)
  layout.frames.forEach((slot, index) => {
    const frame = frames[index]!
    const trim = trims[index]!
    if (!trim.empty) {
      context.drawImage(frame, trim.x, trim.y, trim.w, trim.h, slot.x, slot.y, trim.w, trim.h)
    }
  })
  const pivot = {
    x: Math.max(0, Math.min(1, options.pivot?.x ?? 0.5)),
    y: Math.max(0, Math.min(1, options.pivot?.y ?? 0.5)),
  }
  const animationName = options.animationName?.trim() || 'animation'
  const imageName = options.imageName?.trim() || 'sprite.png'
  const manifestFrames: SpriteFrameManifest[] = layout.frames.map((slot, index) => {
    const source = frames[index]!
    const trim = trims[index]!
    const duration = Math.max(1, Math.round(options.durations?.[index] ?? 100))
    return {
      index,
      sourceFrameId: options.sourceFrameIds?.[index] ?? index,
      filename: `${animationName}_${String(index).padStart(3, '0')}`,
      frame: { x: slot.x, y: slot.y, w: slot.w, h: slot.h },
      rotated: false,
      trimmed: trimMode === 'tight' && (trim.x !== 0 || trim.y !== 0 || trim.w !== source.width || trim.h !== source.height),
      empty: trim.empty,
      spriteSourceSize: { x: trim.x, y: trim.y, w: trim.w, h: trim.h },
      sourceSize: { w: source.width, h: source.height },
      pivot,
      duration,
    }
  })
  return {
    canvas,
    manifest: {
      version: 2,
      image: imageName,
      animation: {
        name: animationName,
        loop: true,
        frameCount: frames.length,
        duration: manifestFrames.reduce((sum, frame) => sum + frame.duration, 0),
      },
      trimMode,
      alphaThreshold,
      frameSize: { width: sourceWidth, height: sourceHeight },
      sheetSize: { width: layout.width, height: layout.height },
      columns: layout.columns,
      rows: layout.rows,
      padding,
      frames: manifestFrames,
    },
  }
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  link.click()
}

export function downloadText(content: string, filename: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  downloadDataUrl(url, filename)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function downloadJson(data: unknown, filename: string): void {
  downloadText(JSON.stringify(data, null, 2), filename, 'application/json')
}
